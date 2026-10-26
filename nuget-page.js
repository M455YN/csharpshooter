// Visual Studio 2026's "NuGet — rozwiązanie" (Manage Packages for Solution), in an editor tab, and its page for one
// project: the tabs Browse, Installed, Updates and Consolidate, the list of top-level packages with their icon, authors,
// description, installed version and the newer one, the vulnerable versions marked and counted in a yellow bar, and the
// selected package's pane with its projects, a version to pick, Install/Update and Uninstall. What the solution has comes
// from dotnet list package (--outdated, --vulnerable) as JSON; icons, descriptions and versions from the package source's
// search service (nuget.org's v3 API); changes are dotnet add/remove package in a task, as Passenger makes them, so the
// SDK writes the version where it belongs (the project, or Directory.Packages.props under central package management).
const vscode = require('vscode');
const { table } = require('./l10n');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { readSolution, terminalTask } = require('./solution');

// Visual Studio's own words (NuGet.PackageManagement.UI's resources).
const T = table({
  solutionTitle: 'NuGet - Solution',
  projectTitle: 'NuGet: {0}',
  solutionHeading: 'Manage Packages for Solution',
  projectHeading: 'NuGet Package Manager: {0}',
  browse: 'Browse',
  installed: 'Installed',
  updates: 'Updates',
  consolidate: 'Consolidate',
  search: 'Search ({0})',
  refresh: 'Refresh',
  prerelease: 'Include prerelease',
  vulnerableOnly: 'Show only vulnerable',
  source: 'Package source:',
  settings: 'Settings',
  vulnerableWarning: 'You have {0} vulnerable package versions installed.',
  topLevel: 'Top-level packages ({0})',
  by: 'by {0}',
  multiple: 'multiple versions installed',
  updateAvailable: 'Update available',
  latestInstalled: 'Latest stable version is installed',
  installedVersion: 'Installed version: {0}',
  vulnerable: 'Vulnerable',
  loading: 'Loading...',
  noPackages: 'No packages found',
  legal: 'Each package is licensed to you by its owner. NuGet is not responsible for, nor does it grant any licenses to, third-party packages.',
  dontShow: "Don't show this again",
  selectAllProjects: 'Select All Projects',
  selectAllPackages: 'Select all packages',
  project: 'Project',
  installedColumn: 'Installed',
  version: 'Version:',
  latestStable: 'Latest stable',
  latestPrerelease: 'Latest prerelease',
  install: 'Install',
  update: 'Update',
  uninstall: 'Uninstall',
  description: 'Description',
  authors: 'Author(s):',
  downloads: 'Downloads:',
  projectUrl: 'Project URL:',
  tags: 'Tags:',
  vulnerabilities: 'Vulnerabilities detected ({0})',
  advisory: 'Advisory ({0} severity):',
  autoReferenced: 'Implicitly referenced by an SDK. To update the package, update the SDK to which it belongs.',
  low: 'low',
  moderate: 'moderate',
  high: 'high',
  critical: 'critical',
  // Not VS's: what VS shows in its Output window or says another way.
  central: 'Versions are managed centrally in {0}.',
  working: 'Running dotnet {0}...',
  done: 'Done.',
  failed: 'dotnet ended with exit code {0}; the terminal says why.',
  noSearch: 'This package source has no search service: only packages from nuget.org and other v3 feeds are listed.',
});
const SEVERITY = { 0: 'low', 1: 'moderate', 2: 'high', 3: 'critical', low: 'low', moderate: 'moderate', high: 'high', critical: 'critical' };

/** NuGet's version order: the numbers one by one, a prerelease below its release, its labels compared part by part. */
function compareVersions(a, b) {
  const [na, pa = ''] = String(a).split('+')[0].split(/-(.*)/s);
  const [nb, pb = ''] = String(b).split('+')[0].split(/-(.*)/s);
  const xa = na.split('.').map(Number);
  const xb = nb.split('.').map(Number);
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const d = (xa[i] || 0) - (xb[i] || 0);
    if (d) return Math.sign(d);
  }
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  const la = pa.split('.');
  const lb = pb.split('.');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] === undefined || lb[i] === undefined) return la[i] === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(la[i]) && /^\d+$/.test(lb[i]);
    const d = numeric ? Number(la[i]) - Number(lb[i]) : la[i].toLowerCase().localeCompare(lb[i].toLowerCase());
    if (d) return Math.sign(d);
  }
  return 0;
}

/** dotnet list package's JSON for a solution or project, with these options; { problem } when dotnet says no JSON. */
function listPackages(target, options) {
  return new Promise((resolve) => {
    const dotnet = spawn('dotnet', ['list', target, 'package', '--format', 'json', ...options], { cwd: path.dirname(target), windowsHide: true });
    let out = '';
    dotnet.stdout.on('data', (d) => (out += d));
    dotnet.stderr.on('data', (d) => (out += d));
    dotnet.on('error', (e) => resolve({ projects: [], problem: e.message }));
    dotnet.on('close', () => {
      try {
        resolve(JSON.parse(out.slice(out.indexOf('{'))));
      } catch {
        resolve({ projects: [], problem: out.trim() });
      }
    });
  });
}

/** The nearest Directory.Packages.props above a project that turns central package management on. */
function centralProps(projectFile) {
  for (let dir = path.dirname(projectFile); ; dir = path.dirname(dir)) {
    const props = path.join(dir, 'Directory.Packages.props');
    if (fs.existsSync(props)) return /<ManagePackageVersionsCentrally>\s*true\s*</i.test(fs.readFileSync(props, 'utf8')) ? props : undefined;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The solution's (or project's) top-level packages, as dotnet resolves them: by id, each with its projects and their
 *  versions, the latest version the sources offer, and the advisories of the versions installed. */
async function readInstalled(target, prerelease) {
  const [all, outdated, vulnerable] = await Promise.all([
    listPackages(target, []),
    listPackages(target, ['--outdated', ...(prerelease ? ['--include-prerelease'] : [])]),
    listPackages(target, ['--vulnerable', '--include-transitive']),
  ]);
  const packages = new Map(); // id (lower case) -> package
  const get = (id) => {
    const key = id.toLowerCase();
    if (!packages.has(key)) packages.set(key, { id, projects: new Map(), latest: undefined, advisories: new Map(), auto: false });
    return packages.get(key);
  };
  const each = (json, fn) => {
    for (const p of json.projects || []) for (const f of p.frameworks || []) for (const x of f.topLevelPackages || []) fn(p.path, x);
  };
  each(all, (project, x) => {
    const pk = get(x.id);
    if (!pk.projects.has(keyOf(project))) pk.projects.set(keyOf(project), { file: path.normalize(project), requested: x.requestedVersion, resolved: x.resolvedVersion || x.requestedVersion });
    pk.auto ||= !!x.autoReferenced;
  });
  each(outdated, (project, x) => {
    const pk = get(x.id);
    if (/^\d/.test(x.latestVersion || '') && (!pk.latest || compareVersions(x.latestVersion, pk.latest) > 0)) pk.latest = x.latestVersion;
  });
  each(vulnerable, (project, x) => get(x.id).advisories.set(x.resolvedVersion, x.vulnerabilities || []));
  // VS counts the vulnerable packages its Installed tab lists, the transitive ones too.
  const transitiveVulnerable = new Set();
  for (const p of vulnerable.projects || []) for (const f of p.frameworks || []) for (const x of f.transitivePackages || []) transitiveVulnerable.add(x.id.toLowerCase());
  const projects = (all.projects || []).map((p) => path.normalize(p.path));
  const problems = [all, outdated, vulnerable].flatMap((j) => [...(j.problems || []).map((p) => p.text), ...(j.problem ? [j.problem] : [])]);
  return { packages, projects, transitiveVulnerable, sources: outdated.sources || all.sources || [], problems: [...new Set(problems)] };
}

const searchServices = new Map(); // source -> its SearchQueryService address, or null
/** A v3 source's search service, from its service index. */
async function searchService(source) {
  if (!searchServices.has(source)) {
    let found = null;
    if (/^https?:.*\.json$/i.test(source)) {
      try {
        const index = await (await fetch(source)).json();
        found = (index.resources || []).find((r) => /^SearchQueryService/.test(r['@type']))?.['@id'] || null;
      } catch {
        found = null;
      }
    }
    searchServices.set(source, found);
  }
  return searchServices.get(source);
}

/** Packages a source finds for a query, as its search service gives them (id, version, description, authors, iconUrl,
 *  versions, totalDownloads, projectUrl, tags); undefined when the source has no search service. */
async function search(source, query, prerelease, take = 25) {
  const service = await searchService(source);
  if (!service) return undefined;
  const url = new URL(service);
  url.searchParams.set('q', query);
  url.searchParams.set('prerelease', String(!!prerelease));
  url.searchParams.set('semVerLevel', '2.0.0');
  url.searchParams.set('take', String(take));
  const answer = await (await fetch(url)).json();
  return answer.data || [];
}

// A project's key: dotnet writes its path with forward slashes, the solution's reader with backslashes, Windows ignores case.
const keyOf = (file) => (process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file));

const sourceName = (source) => (/api\.nuget\.org/i.test(source) ? 'nuget.org' : source);

function registerNuGetPage(context, findSolution) {
  const pages = new Map(); // solution or project file -> panel
  const state = { last: undefined }; // for the tests: the last change's exit codes

  const open = async (item) => {
    const target = item?.file || (await findSolution());
    if (!target) return undefined;
    const existing = pages.get(target);
    if (existing) {
      existing.reveal();
      return existing;
    }
    const isProject = /proj$/i.test(target);
    const name = path.basename(target, path.extname(target));
    const panel = vscode.window.createWebviewPanel('csharpShooter.nuget', isProject ? T.projectTitle(name) : T.solutionTitle, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = new vscode.ThemeIcon('package');
    pages.set(target, panel);
    panel.onDidDispose(() => pages.delete(target));
    const post = (m) => panel.webview.postMessage(m);

    // What the page shows; the solution's projects are its own, a project page's only that project.
    const solutionProjects = () => {
      if (isProject) return [target];
      const walk = (node) => [...node.projects, ...node.folders.flatMap(walk)];
      return walk(readSolution(target));
    };
    const view = { tab: 'installed', query: '', prerelease: false, vulnerableOnly: false, source: undefined, selected: undefined, checked: new Set(), status: undefined };
    let data = { packages: new Map(), projects: [], sources: [], problems: [] };
    let loading;
    let browsed; // the Browse tab's results
    const meta = new Map(); // source|id -> the search service's entry for a package, or null

    const metaOf = (id) => meta.get(`${view.source}|${id.toLowerCase()}`);
    const fetchMeta = async (ids) => {
      const missing = ids.filter((id) => metaOf(id) === undefined);
      await Promise.all(missing.map(async (id) => {
        let found = null;
        try {
          found = (await search(view.source, `packageid:${id}`, true, 1))?.find((x) => x.id.toLowerCase() === id.toLowerCase()) || null;
        } catch {
          found = null;
        }
        meta.set(`${view.source}|${id.toLowerCase()}`, found);
      }));
    };

    const reload = async () => {
      loading = true;
      show();
      const read = await readInstalled(target, view.prerelease);
      // A restore that failed (NU1605, a downgrade a change caused) leaves dotnet list with nothing: the list stays as it
      // was, the error above it.
      data = read.projects.length || !data.projects.length ? read : { ...data, problems: read.problems };
      if (!view.source || !data.sources.includes(view.source)) view.source = data.sources.find((s) => /^https?:/.test(s)) || data.sources[0];
      loading = false;
      show();
      await fetchMeta([...data.packages.values()].map((p) => p.id));
      show();
    };

    const browseNow = async () => {
      browsed = undefined;
      show();
      try {
        browsed = (await search(view.source, view.query, view.prerelease)) ?? null;
      } catch (e) {
        browsed = [];
        view.status = { text: e.message, error: true };
      }
      for (const x of browsed || []) meta.set(`${view.source}|${x.id.toLowerCase()}`, x);
      show();
    };

    const installedVersions = (pk) => [...new Set([...pk.projects.values()].map((v) => v.resolved))].sort(compareVersions);
    const vulnerableVersions = (pk) => [...pk.advisories.entries()].filter(([, a]) => a.length).map(([v]) => v);
    const hasUpdate = (pk) => !pk.auto && pk.latest && installedVersions(pk).some((v) => compareVersions(pk.latest, v) > 0);

    /** A list row: what VS shows of a package. */
    const rowOf = (id, found) => {
      const pk = data.packages.get(id.toLowerCase());
      const m = found || metaOf(id);
      const versions = pk ? installedVersions(pk) : [];
      return {
        id: pk?.id || m?.id || id,
        authors: m ? [].concat(m.authors || []).join(', ') : '',
        description: m?.description || '',
        icon: m?.iconUrl || '',
        installed: versions.length > 1 ? T.multiple : versions[0] || '',
        latest: pk ? (hasUpdate(pk) ? pk.latest : '') : m?.version || '',
        update: !!pk && !!hasUpdate(pk),
        upToDate: !!pk && !hasUpdate(pk),
        vulnerable: !!pk && vulnerableVersions(pk).length > 0,
      };
    };

    const rows = () => {
      const q = view.query.toLowerCase();
      const all = [...data.packages.values()].filter((p) => !q || p.id.toLowerCase().includes(q)).sort((a, b) => a.id.localeCompare(b.id));
      if (view.tab === 'browse') return (browsed || []).map((x) => rowOf(x.id, x));
      if (view.tab === 'updates') return all.filter(hasUpdate).map((p) => rowOf(p.id));
      if (view.tab === 'consolidate') return all.filter((p) => installedVersions(p).length > 1).map((p) => rowOf(p.id));
      return all.filter((p) => !view.vulnerableOnly || vulnerableVersions(p).length).map((p) => rowOf(p.id));
    };

    /** The selected package's pane: its projects and versions, the versions to pick, its advisories and its details. */
    const details = () => {
      if (!view.selected) return null;
      const pk = data.packages.get(view.selected.toLowerCase());
      const m = metaOf(view.selected) || (browsed || []).find((x) => x.id.toLowerCase() === view.selected.toLowerCase());
      const offered = (m?.versions || []).map((v) => v.version).filter((v) => view.prerelease || !v.includes('-'));
      const versions = [...new Set([...offered, ...(pk ? installedVersions(pk) : [])])].sort(compareVersions).reverse();
      const stable = versions.find((v) => !v.includes('-'));
      const advisories = pk ? vulnerableVersions(pk).flatMap((v) => pk.advisories.get(v).map((a) => ({ version: v, severity: SEVERITY[String(a.severity).toLowerCase()] || 'moderate', url: a.advisoryurl }))) : [];
      const central = [...new Set(solutionProjects().map(centralProps).filter(Boolean))];
      return {
        id: pk?.id || m?.id || view.selected,
        icon: m?.iconUrl || '',
        auto: !!pk?.auto,
        projects: solutionProjects().map((file) => ({ file, name: path.basename(file, path.extname(file)), version: pk?.projects.get(keyOf(file))?.resolved || '', checked: view.checked.has(file) })),
        versions: versions.map((v) => ({ value: v, label: v === versions[0] && v.includes('-') ? `${T.latestPrerelease} ${v}` : v === stable ? `${T.latestStable} ${v}` : v })),
        chosen: view.tab === 'updates' || view.tab === 'browse' || !pk ? (view.prerelease ? versions[0] : stable || versions[0]) : installedVersions(pk).at(-1),
        advisories: advisories.map((a) => ({ ...a, label: T.advisory(T[a.severity]) })),
        description: m?.description || '',
        authors: m ? [].concat(m.authors || []).join(', ') : '',
        downloads: m?.totalDownloads ? m.totalDownloads.toLocaleString('pl-PL') : '',
        projectUrl: m?.projectUrl || '',
        tags: [].concat(m?.tags || []).join(', '),
        central: central.length ? T.central(central.map((f) => path.relative(path.dirname(target), f)).join(', ')) : '',
      };
    };

    const show = () => {
      const packages = [...data.packages.values()];
      const vulnerableCount = new Set([...packages.filter((p) => vulnerableVersions(p).length).map((p) => p.id.toLowerCase()), ...(data.transitiveVulnerable || [])]).size;
      post((panel.shown = {
        type: 'show',
        tab: view.tab,
        loading: loading || (view.tab === 'browse' && browsed === undefined),
        heading: isProject ? T.projectHeading(name) : T.solutionHeading,
        rows: loading ? [] : rows(),
        noSearch: view.tab === 'browse' && browsed === null,
        updates: packages.filter(hasUpdate).length,
        consolidate: packages.filter((p) => installedVersions(p).length > 1).length,
        vulnerableCount,
        sources: data.sources.map((s) => ({ value: s, label: sourceName(s) })),
        source: view.source,
        selected: view.selected,
        details: details(),
        status: data.problems.length && !view.status?.busy ? { text: data.problems[0], error: true } : view.status,
        legal: !context.globalState.get('csharpShooter.nuget.hideLegal'),
        prerelease: view.prerelease,
        vulnerableOnly: view.vulnerableOnly,
      }));
    };

    /** dotnet add/remove package for each of these projects, one task after another, then the packages read again. */
    const change = async (steps) => {
      const codes = [];
      for (const [project, args] of steps) {
        if (args.some((a) => !a || a.startsWith('-') && !['--version'].includes(a))) continue; // an id or version read as an option
        view.status = { text: T.working(args.join(' ')), busy: true };
        show();
        codes.push(await terminalTask(`NuGet: ${path.basename(project, path.extname(project))}`, args, path.dirname(project)));
      }
      // dotnet add restores the project alone, and the C# server may restore it as the file changes: the solution is
      // restored once more, so dotnet list reads whole assets (Passenger restores after a set of changes too).
      if (codes.length) {
        view.status = { text: T.working('restore'), busy: true };
        show();
        await terminalTask(`NuGet: restore ${name}`, ['restore', target], path.dirname(target));
      }
      const bad = codes.find((c) => c !== 0);
      view.status = bad === undefined ? { text: T.done, ok: true } : { text: T.failed(bad), error: true };
      state.last = { codes, steps };
      await reload();
      return state.last;
    };

    const request = (panel.request = async (m) => {
      if (m.type === 'ready') return data.projects.length ? show() : reload();
      if (m.type === 'tab') {
        view.tab = m.tab;
        view.status = undefined;
        if (m.tab === 'browse' && browsed === undefined) return browseNow();
      }
      if (m.type === 'search') {
        view.query = m.query;
        if (view.tab === 'browse') return browseNow();
      }
      if (m.type === 'prerelease') {
        view.prerelease = !!m.value;
        if (view.tab === 'browse') browseNow();
        return reload();
      }
      if (m.type === 'vulnerableOnly') view.vulnerableOnly = !!m.value;
      if (m.type === 'source') {
        view.source = m.source;
        if (view.tab === 'browse') return browseNow();
        await fetchMeta([...data.packages.values()].map((p) => p.id));
      }
      if (m.type === 'refresh') {
        if (view.tab === 'browse') browseNow();
        return reload();
      }
      if (m.type === 'select') {
        view.selected = m.id;
        const pk = data.packages.get(m.id.toLowerCase());
        view.checked = new Set(solutionProjects().filter((f) => pk?.projects.has(keyOf(f))));
        if (isProject) view.checked = new Set([target]);
        show();
        await fetchMeta([m.id]);
      }
      if (m.type === 'check') {
        for (const file of m.files) m.value ? view.checked.add(file) : view.checked.delete(file);
      }
      if (m.type === 'install' && view.selected && m.version) {
        const pk = data.packages.get(view.selected.toLowerCase());
        const id = pk?.id || view.selected;
        const projects = [...view.checked].filter((f) => pk?.projects.get(keyOf(f))?.resolved !== m.version);
        return change(projects.map((f) => [f, ['add', f, 'package', id, '--version', m.version]]));
      }
      if (m.type === 'uninstall' && view.selected) {
        const pk = data.packages.get(view.selected.toLowerCase());
        const projects = [...view.checked].filter((f) => pk?.projects.has(keyOf(f)));
        return change(projects.map((f) => [f, ['remove', f, 'package', pk.id]]));
      }
      if (m.type === 'updateAll') {
        const steps = [];
        for (const id of m.ids) {
          const pk = data.packages.get(id.toLowerCase());
          if (!pk || !hasUpdate(pk)) continue;
          for (const v of pk.projects.values()) if (compareVersions(pk.latest, v.resolved) > 0) steps.push([v.file, ['add', v.file, 'package', pk.id, '--version', pk.latest]]);
        }
        return change(steps);
      }
      if (m.type === 'hideLegal') await context.globalState.update('csharpShooter.nuget.hideLegal', true);
      if (m.type === 'link' && /^https?:/i.test(m.url)) return vscode.env.openExternal(vscode.Uri.parse(m.url));
      if (m.type === 'settings') {
        // VS's gear opens Options > NuGet Package Manager > Package Sources, which edit the user's NuGet.Config.
        const config = process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'NuGet', 'NuGet.Config') : path.join(os.homedir(), '.nuget', 'NuGet', 'NuGet.Config');
        if (fs.existsSync(config)) await vscode.window.showTextDocument(vscode.Uri.file(config));
        return;
      }
      show();
    });
    panel.webview.onDidReceiveMessage(request);
    panel.webview.html = html();
    panel.state = state;
    panel.loaded = () => new Promise((resolve) => {
      const wait = () => (!loading && data.projects.length ? resolve(data) : setTimeout(wait, 200));
      wait();
    });
    return panel;
  };

  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.solution.manageNuGet', open));
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.solution.manageNuGetSolution', () => open()));

  function html() {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const texts = {
      by: T.by('{0}'), topLevel: T.topLevel('{0}'), vulnerableWarning: T.vulnerableWarning('{0}'), loading: T.loading, noPackages: T.noPackages,
      updateAvailable: T.updateAvailable, latestInstalled: T.latestInstalled, installedVersion: T.installedVersion('{0}'), vulnerable: T.vulnerable,
      selectAllProjects: T.selectAllProjects, selectAllPackages: T.selectAllPackages, project: T.project, installedColumn: T.installedColumn,
      version: T.version, install: T.install, update: T.update, uninstall: T.uninstall, description: T.description, authors: T.authors,
      downloads: T.downloads, projectUrl: T.projectUrl, tags: T.tags, vulnerabilities: T.vulnerabilities('{0}'), autoReferenced: T.autoReferenced,
      noSearch: T.noSearch,
    };
    // A package without an icon gets NuGet's default: a blue box.
    const defaultIcon = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#1e88e5" d="M16 2 3 8v16l13 6 13-6V8z"/><path fill="#90caf9" d="M16 2 3 8l13 6 13-6z"/></svg>')}`;
    return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); --accent: var(--vscode-textLink-foreground); }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .head { display: flex; align-items: center; gap: 28px; padding: 14px 20px 6px; }
  .tab { cursor: pointer; font-size: 1.15em; padding: 2px 0; border-bottom: 2px solid transparent; user-select: none; }
  .tab.on { color: var(--accent); border-color: var(--accent); }
  .tab .badge { font-size: .75em; padding: 0 4px; margin-left: 4px; color: #fff; background: var(--vscode-activityBarBadge-background, #0078d4); }
  .tab .warn { color: var(--vscode-editorWarning-foreground, #cca700); margin-left: 4px; }
  .heading { margin-left: auto; font-size: 1.35em; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 20px 10px; flex-wrap: wrap; }
  input[type=text], select { font: inherit; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  #query { width: 300px; }
  .icon-btn { cursor: pointer; background: none; border: 0; color: inherit; font-size: 1.1em; padding: 2px 6px; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  label.check { display: flex; gap: 6px; align-items: center; }
  .right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .banner { display: flex; align-items: center; gap: 8px; padding: 5px 20px; color: var(--vscode-editorWarning-foreground, #cca700);
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 15%, transparent); }
  .banner .text { color: var(--vscode-foreground); }
  .banner .close { margin-left: auto; }
  .main { flex: 1; display: flex; min-height: 0; border-top: 1px solid var(--line); }
  .list { flex: 1; overflow: auto; border-right: 1px solid var(--line); }
  .pane { flex: 1; overflow: auto; padding: 14px 18px; }
  .group { padding: 8px 12px 4px; display: flex; gap: 6px; align-items: center; }
  .row { display: flex; gap: 12px; padding: 8px 12px; cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.on { background: var(--vscode-list-inactiveSelectionBackground); }
  .row .pick { align-self: center; }
  .ic { position: relative; width: 32px; height: 32px; flex: none; }
  .ic img { width: 32px; height: 32px; object-fit: contain; }
  .ic .over { position: absolute; right: -4px; bottom: -4px; width: 14px; height: 14px; border-radius: 50%; font-size: 10px; line-height: 14px; text-align: center; color: #fff; }
  .ic .over.up { background: #1e88e5; }
  .ic .over.ok { background: #2e9d4c; }
  .what { flex: 1; min-width: 0; }
  .what .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .what .name { font-weight: 600; font-size: 1.1em; }
  .what .by { color: var(--muted); margin-left: 4px; }
  .what .desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .ver { text-align: right; white-space: nowrap; display: flex; flex-direction: column; gap: 10px; }
  .ver .newer { color: var(--accent); }
  .warnIcon { color: var(--vscode-editorWarning-foreground, #cca700); margin-right: 4px; }
  .empty { color: var(--muted); padding: 20px; }
  .status { padding: 4px 20px; }
  .status.error { color: var(--vscode-errorForeground); }
  .status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .foot { border-top: 1px solid var(--line); padding: 8px 20px; display: flex; flex-direction: column; gap: 6px; }
  .pane h2 { display: flex; align-items: center; gap: 10px; font-size: 1.4em; font-weight: 600; margin: 0 0 12px; }
  .pane h2 img { width: 32px; height: 32px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; }
  .actions { display: flex; align-items: center; gap: 8px; margin: 8px 0 14px; flex-wrap: wrap; }
  button { font: inherit; padding: 3px 14px; border: 1px solid transparent; cursor: pointer; border-radius: 2px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:disabled { opacity: .5; cursor: default; }
  .vuln { border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); padding: 6px 10px; margin: 10px 0; background: var(--vscode-textBlockQuote-background); }
  a { color: var(--accent); cursor: pointer; text-decoration: none; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .note { color: var(--muted); margin: 6px 0; }
</style></head><body>
<div class="head">
  <span class="tab" data-tab="browse">${esc(T.browse)}</span>
  <span class="tab" data-tab="installed">${esc(T.installed)}<span class="warn" id="installedWarn" hidden>⚠</span></span>
  <span class="tab" data-tab="updates">${esc(T.updates)}<span class="badge" id="updatesBadge" hidden></span></span>
  <span class="tab" data-tab="consolidate">${esc(T.consolidate)}<span class="badge" id="consolidateBadge" hidden></span></span>
  <span class="heading" id="heading"></span>
</div>
<div class="bar">
  <input type="text" id="query" placeholder="${esc(T.search('Ctrl+L'))}" spellcheck="false">
  <button class="icon-btn" id="refresh" title="${esc(T.refresh)}">⟳</button>
  <label class="check"><input type="checkbox" id="prerelease"> ${esc(T.prerelease)}</label>
  <label class="check" id="vulnerableOnlyBox"><input type="checkbox" id="vulnerableOnly"> ${esc(T.vulnerableOnly)}</label>
  <span class="right"><label for="source">${esc(T.source)}</label><select id="source"></select>
    <button class="icon-btn" id="settings" title="${esc(T.settings)}">⚙</button></span>
</div>
<div class="banner" id="banner" hidden><span>⚠</span><span class="text" id="bannerText"></span><button class="icon-btn close" id="bannerClose">✕</button></div>
<div class="status" id="status" hidden></div>
<div class="main">
  <div class="list" id="list"></div>
  <div class="pane" id="pane"></div>
</div>
<div class="foot" id="foot"><span>${esc(T.legal)}</span><label class="check"><input type="checkbox" id="hideLegal"> ${esc(T.dontShow)}</label></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const T = ${JSON.stringify(texts)};
  const fill = (s, v) => s.replace('{0}', v);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const DEFAULT_ICON = ${JSON.stringify(defaultIcon)};
  const img = (src) => '<img src="' + esc(src || DEFAULT_ICON) + '" data-fallback="1" alt="">';
  let m, bannerClosed = false;
  const picked = new Set(); // the Updates tab's packages to update together
  const send = (msg) => vscode.postMessage(msg);
  document.querySelectorAll('.tab').forEach((el) => el.onclick = () => send({ type: 'tab', tab: el.dataset.tab }));
  let typing;
  $('query').oninput = () => { clearTimeout(typing); typing = setTimeout(() => send({ type: 'search', query: $('query').value }), 300); };
  $('refresh').onclick = () => send({ type: 'refresh' });
  $('prerelease').onchange = () => send({ type: 'prerelease', value: $('prerelease').checked });
  $('vulnerableOnly').onchange = () => send({ type: 'vulnerableOnly', value: $('vulnerableOnly').checked });
  $('source').onchange = () => send({ type: 'source', source: $('source').value });
  $('settings').onclick = () => send({ type: 'settings' });
  $('bannerClose').onclick = () => { bannerClosed = true; $('banner').hidden = true; };
  $('hideLegal').onchange = () => { $('foot').hidden = true; send({ type: 'hideLegal' }); };
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('query').focus(); $('query').select(); } });
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.dataset.fallback) { e.target.dataset.fallback = ''; e.target.src = DEFAULT_ICON; } }, true);
  document.addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) send({ type: 'link', url: a.dataset.url }); });

  function rowHtml(r) {
    const over = r.update ? '<span class="over up" title="' + esc(T.updateAvailable) + '">↑</span>' : r.upToDate ? '<span class="over ok" title="' + esc(T.latestInstalled) + '">✓</span>' : '';
    const pick = m.tab === 'updates' ? '<input type="checkbox" class="pick" data-id="' + esc(r.id) + '"' + (picked.has(r.id) ? ' checked' : '') + '>' : '';
    return '<div class="row' + (m.selected && m.selected.toLowerCase() === r.id.toLowerCase() ? ' on' : '') + '" data-id="' + esc(r.id) + '">' + pick
      + '<div class="ic">' + img(r.icon) + over + '</div>'
      + '<div class="what"><div class="title" title="' + esc(r.id) + '"><span class="name">' + esc(r.id) + '</span>' + (r.authors ? '<span class="by">' + esc(fill(T.by, r.authors)) + '</span>' : '') + '</div>'
      + '<div class="desc">' + esc(r.description) + '</div></div>'
      + '<div class="ver">' + (r.installed ? '<span title="' + esc(fill(T.installedVersion, r.installed)) + '">' + (r.vulnerable ? '<span class="warnIcon" title="' + esc(T.vulnerable) + '">⚠</span>' : '') + esc(r.installed) + '</span>' : '')
      + (r.latest ? '<span class="' + (r.installed ? 'newer' : '') + '">' + esc(r.latest) + '</span>' : '') + '</div></div>';
  }

  function paneHtml(d) {
    if (!d) return '';
    const canChange = !d.auto;
    const all = d.projects.length && d.projects.every((p) => p.checked);
    let h = '<h2>' + img(d.icon) + esc(d.id) + '</h2>';
    if (d.auto) h += '<div class="note">' + esc(T.autoReferenced) + '</div>';
    h += '<table><tr><th><input type="checkbox" id="allProjects"' + (all ? ' checked' : '') + ' title="' + esc(T.selectAllProjects) + '"></th><th>' + esc(T.project) + '</th><th>' + esc(T.installedColumn) + '</th></tr>'
      + d.projects.map((p) => '<tr><td><input type="checkbox" class="proj" data-file="' + esc(p.file) + '"' + (p.checked ? ' checked' : '') + '></td><td>' + esc(p.name) + '</td><td>' + esc(p.version) + '</td></tr>').join('') + '</table>';
    if (d.central) h += '<div class="note">' + esc(d.central) + '</div>';
    h += '<div class="actions"><label for="version">' + esc(T.version) + '</label><select id="version">'
      + d.versions.map((v) => '<option value="' + esc(v.value) + '"' + (v.value === d.chosen ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('') + '</select>'
      + '<button class="primary" id="install"' + (canChange ? '' : ' disabled') + '>' + esc(m.tab === 'updates' ? T.update : T.install) + '</button>'
      + '<button id="uninstall"' + (canChange && d.projects.some((p) => p.checked && p.version) ? '' : ' disabled') + '>' + esc(T.uninstall) + '</button></div>';
    if (d.advisories.length) {
      h += '<div class="vuln"><b>' + esc(fill(T.vulnerabilities, d.advisories.length)) + '</b>'
        + d.advisories.map((a) => '<div>' + esc(a.version) + ' – ' + esc(a.label) + ' <a data-url="' + esc(a.url) + '">' + esc(a.url) + '</a></div>').join('') + '</div>';
    }
    h += '<dl>';
    if (d.description) h += '<dt>' + esc(T.description) + '</dt><dd>' + esc(d.description) + '</dd>';
    if (d.authors) h += '<dt>' + esc(T.authors) + '</dt><dd>' + esc(d.authors) + '</dd>';
    if (d.downloads) h += '<dt>' + esc(T.downloads) + '</dt><dd>' + esc(d.downloads) + '</dd>';
    if (d.projectUrl) h += '<dt>' + esc(T.projectUrl) + '</dt><dd><a data-url="' + esc(d.projectUrl) + '">' + esc(d.projectUrl) + '</a></dd>';
    if (d.tags) h += '<dt>' + esc(T.tags) + '</dt><dd>' + esc(d.tags) + '</dd>';
    return h + '</dl>';
  }

  function render() {
    document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === m.tab));
    $('heading').textContent = m.heading;
    $('installedWarn').hidden = !m.vulnerableCount;
    $('updatesBadge').hidden = !m.updates; $('updatesBadge').textContent = m.updates;
    $('consolidateBadge').hidden = !m.consolidate; $('consolidateBadge').textContent = m.consolidate;
    $('banner').hidden = bannerClosed || !m.vulnerableCount;
    $('bannerText').textContent = fill(T.vulnerableWarning, m.vulnerableCount);
    $('prerelease').checked = m.prerelease;
    $('vulnerableOnly').checked = m.vulnerableOnly;
    $('vulnerableOnlyBox').hidden = m.tab !== 'installed';
    $('source').innerHTML = m.sources.map((s) => '<option value="' + esc(s.value) + '">' + esc(s.label) + '</option>').join('');
    $('source').value = m.source || '';
    $('foot').hidden = !m.legal;
    const st = $('status');
    st.hidden = !m.status; st.className = 'status' + (m.status?.error ? ' error' : m.status?.ok ? ' ok' : '');
    st.textContent = m.status?.text || '';
    let list = '';
    if (m.loading) list = '<div class="empty">' + esc(T.loading) + '</div>';
    else if (m.noSearch) list = '<div class="empty">' + esc(T.noSearch) + '</div>';
    else if (!m.rows.length) list = '<div class="empty">' + esc(T.noPackages) + '</div>';
    else {
      if (m.tab === 'updates') list += '<div class="group"><label class="check"><input type="checkbox" id="allPackages"' + (m.rows.every((r) => picked.has(r.id)) ? ' checked' : '') + '> ' + esc(T.selectAllPackages) + '</label><button class="primary" id="updateAll"' + (picked.size ? '' : ' disabled') + '>' + esc(T.update) + '</button></div>';
      if (m.tab !== 'browse') list += '<div class="group">⌃ ' + esc(fill(T.topLevel, m.rows.length)) + '</div>';
      list += m.rows.map(rowHtml).join('');
    }
    const scroll = $('list').scrollTop;
    $('list').innerHTML = list;
    $('list').scrollTop = scroll;
    $('pane').innerHTML = paneHtml(m.details);
    $('list').querySelectorAll('.row').forEach((el) => el.onclick = (e) => { if (!e.target.classList.contains('pick')) send({ type: 'select', id: el.dataset.id }); });
    $('list').querySelectorAll('.pick').forEach((el) => el.onchange = () => { el.checked ? picked.add(el.dataset.id) : picked.delete(el.dataset.id); render(); });
    if ($('allPackages')) $('allPackages').onchange = () => { m.rows.forEach((r) => $('allPackages').checked ? picked.add(r.id) : picked.delete(r.id)); render(); };
    if ($('updateAll')) $('updateAll').onclick = () => send({ type: 'updateAll', ids: [...picked] });
    if (!m.details) return;
    $('pane').querySelectorAll('.proj').forEach((el) => el.onchange = () => send({ type: 'check', files: [el.dataset.file], value: el.checked }));
    $('allProjects').onchange = () => send({ type: 'check', files: m.details.projects.map((p) => p.file), value: $('allProjects').checked });
    $('install').onclick = () => send({ type: 'install', version: $('version').value });
    $('uninstall').onclick = () => send({ type: 'uninstall' });
  }
  window.addEventListener('message', (ev) => { if (ev.data.type === 'show') { m = ev.data; render(); } });
  send({ type: 'ready' });
</script></body></html>`;
  }

  return { open, pages, state, compareVersions, readInstalled };
}

module.exports = { registerNuGetPage, compareVersions };
