// Visual Studio 2026's "NuGet — rozwiązanie" (Manage Packages for Solution), in an editor tab, and its page for one
// project: the tabs Browse, Installed, Updates and Consolidate, the top-level and transitive packages with their icon,
// authors, description, installed version and the newer one, vulnerable and deprecated versions marked and counted in a
// yellow bar, and the selected package's pane: its projects, a version to pick, Install/Update and Uninstall, its
// deprecation and advisories, its details (licence, date published, dependencies) or README, and the package source
// mapping. Install and Uninstall show VS's Preview Changes and, for a package that asks for it, License Acceptance.
// What the solution has comes from dotnet list package as JSON; what a source offers from nuget-feeds.js; changes are
// dotnet add/remove package in a task, as Passenger makes them (tried again when another program holds the project
// file), so the SDK writes the version where it belongs (the project, or Directory.Packages.props).
const vscode = require('vscode');
const { table } = require('./l10n');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { readSolution } = require('./solution');
const feeds = require('./nuget-feeds');

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
  allSources: 'All',
  settings: 'Settings',
  vulnerableWarning: 'You have {0} vulnerable package versions installed.',
  deprecatedWarning: 'You have {0} deprecated package versions installed.',
  bothWarning: 'You have {0} vulnerable package versions and {1} deprecated package versions installed.',
  topLevel: 'Top-level packages ({0})',
  transitive: 'Transitive packages ({0})',
  transitiveLevel: 'Transitive',
  transitiveVersion: 'Transitively referenced version: {0}',
  by: 'by {0}',
  multiple: 'multiple versions installed',
  updateAvailable: 'Update available',
  latestInstalled: 'Latest stable version is installed',
  installedVersion: 'Installed version: {0}',
  vulnerable: 'Vulnerable',
  deprecated: 'Deprecated',
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
  packageDetails: 'Package Details',
  readme: 'README',
  loadingReadme: 'Loading README...',
  noReadme: 'There is no README available for the selected package version. For more information visit [aka.ms/nuget/noreadme](https://aka.ms/nuget/noreadme).',
  description: 'Description',
  authors: 'Author(s):',
  license: 'License:',
  viewLicense: 'View License',
  published: 'Date published:',
  downloads: 'Downloads:',
  projectUrl: 'Project URL:',
  tags: 'Tags:',
  dependencies: 'Dependencies',
  noDependencies: 'No dependencies',
  vulnerabilities: 'Vulnerabilities detected ({0})',
  advisory: 'Advisory ({0} severity):',
  deprecatedVersion: 'This package version is deprecated.',
  deprecatedUse: 'This package version is deprecated. Use {0} instead.',
  deprecationReason: 'Deprecation reason',
  reasonLegacy: 'This package has been deprecated as it is legacy and no longer maintained.',
  reasonCriticalBugs: 'This package has been deprecated as it has critical bugs.',
  reasonBoth: 'This package has been deprecated as it has critical bugs and is no longer maintained.',
  reasonUnknown: 'The package has been deprecated.',
  alternate: 'Alternate package',
  autoReferenced: 'Implicitly referenced by an SDK. To update the package, update the SDK to which it belongs.',
  low: 'low',
  moderate: 'moderate',
  high: 'high',
  critical: 'critical',
  options: 'Options',
  showPreview: 'Show preview window',
  previewTitle: 'Preview Changes',
  installing: 'Installing:',
  uninstalling: 'Uninstalling:',
  updatesColon: 'Updates:',
  previewUpdate: '{0} version {1} to {2} version {3}',
  ok: 'OK',
  cancel: 'Cancel',
  licenseTitle: 'License Acceptance',
  licenseHeader: 'The following package(s) require that you accept their license terms before installing.',
  licenseText: 'By clicking "I Accept," you agree to the license terms for the package(s) listed above. If you do not agree to the license terms, click "I Decline."',
  accept: 'I Accept',
  decline: 'I Decline',
  mappingFound: 'Package source mapping found.',
  mappingNotFound: 'Requires a package source mapping.',
  mappingAuto: 'A package source mapping will be created.',
  mappingOff: 'Package source mapping is off.',
  creatingMappings: "Creating source mappings to '{0}':",
  configure: 'Configure',
  // Not VS's: what VS shows in its Output window or says another way.
  central: 'Versions are managed centrally in {0}.',
  working: 'Running dotnet {0}...',
  retrying: 'Another program has the project file open; trying again ({0})...',
  done: 'Done.',
  failed: 'dotnet ended with exit code {0}; the terminal says why.',
  declined: 'Nothing was changed.',
  mappingNeedsSource: 'Choose one package source: the package is mapped to the source it is installed from.',
  noSearch: 'This package source has neither a search service nor packages in its folder.',
});
const SEVERITY = { 0: 'low', 1: 'moderate', 2: 'high', 3: 'critical', low: 'low', moderate: 'moderate', high: 'high', critical: 'critical' };
const ALL = '*'; // VS's "All" package source

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

// A project's key: dotnet writes its path with forward slashes, the solution's reader with backslashes, Windows ignores case.
const keyOf = (file) => (process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file));

/** The solution's (or project's) packages, as dotnet resolves them: by id, each with the projects that reference it
 *  (top-level) and those that get it through another (transitive), the latest version the sources offer, and the
 *  advisories and deprecation of the versions installed. */
async function readInstalled(target, prerelease) {
  const [all, outdated, vulnerable, deprecated] = await Promise.all([
    listPackages(target, ['--include-transitive']),
    listPackages(target, ['--outdated', ...(prerelease ? ['--include-prerelease'] : [])]),
    listPackages(target, ['--vulnerable', '--include-transitive']),
    listPackages(target, ['--deprecated']),
  ]);
  const packages = new Map(); // id (lower case) -> package
  const get = (id) => {
    const key = id.toLowerCase();
    if (!packages.has(key)) packages.set(key, { id, projects: new Map(), transitive: new Map(), latest: undefined, advisories: new Map(), deprecations: new Map(), auto: false });
    return packages.get(key);
  };
  const each = (json, fn, kinds = ['topLevelPackages']) => {
    for (const p of json.projects || []) for (const f of p.frameworks || []) for (const kind of kinds) for (const x of f[kind] || []) fn(p.path, x, kind);
  };
  each(all, (project, x, kind) => {
    const pk = get(x.id);
    const into = kind === 'topLevelPackages' ? pk.projects : pk.transitive;
    if (!into.has(keyOf(project))) into.set(keyOf(project), { file: path.normalize(project), requested: x.requestedVersion, resolved: x.resolvedVersion || x.requestedVersion });
    pk.auto ||= !!x.autoReferenced;
  }, ['topLevelPackages', 'transitivePackages']);
  // A package a project references itself is top-level there, whatever another brings.
  for (const pk of packages.values()) for (const key of pk.projects.keys()) pk.transitive.delete(key);
  each(outdated, (project, x) => {
    const pk = get(x.id);
    if (/^\d/.test(x.latestVersion || '') && (!pk.latest || compareVersions(x.latestVersion, pk.latest) > 0)) pk.latest = x.latestVersion;
  });
  each(vulnerable, (project, x) => get(x.id).advisories.set(x.resolvedVersion, x.vulnerabilities || []), ['topLevelPackages', 'transitivePackages']);
  each(deprecated, (project, x) => get(x.id).deprecations.set(x.resolvedVersion, { reasons: x.deprecationReasons || [], alternate: x.alternativePackage ? { id: x.alternativePackage.id, range: x.alternativePackage.versionRange || '' } : null }));
  const projects = (all.projects || []).map((p) => path.normalize(p.path));
  const problems = [all, outdated, vulnerable, deprecated].flatMap((j) => [...(j.problems || []).map((p) => p.text), ...(j.problem ? [j.problem] : [])]);
  return { packages, projects, sources: outdated.sources || all.sources || [], problems: [...new Set(problems)] };
}

const LOCKED = /being used by another process|używany przez inny proces/i;
/** dotnet with these arguments in a task of its own, its output in the task's terminal and kept: { code, said }. Run
 *  again (three times at most) when it failed only because another program had the project file open, as Passenger
 *  runs it: Windows refuses that write, and the project is left as it was. */
async function dotnetTask(name, args, cwd, onRetry = () => {}) {
  for (let attempt = 1; ; attempt++) {
    const result = await new Promise((resolve) => {
      const write = new vscode.EventEmitter();
      const close = new vscode.EventEmitter();
      let said = '';
      const pty = {
        onDidWrite: write.event,
        onDidClose: close.event,
        open() {
          write.fire(`> dotnet ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\r\n`);
          const child = spawn('dotnet', args, { cwd, windowsHide: true });
          const out = (d) => {
            said += d;
            write.fire(String(d).replace(/\r?\n/g, '\r\n'));
          };
          child.stdout.on('data', out);
          child.stderr.on('data', out);
          child.on('error', (e) => (out(`${e.message}\n`), close.fire(1), resolve({ code: 1, said })));
          child.on('close', (code) => (close.fire(code ?? 1), resolve({ code: code ?? 1, said })));
        },
        close() {},
      };
      vscode.tasks.executeTask(new vscode.Task({ type: 'csharpShooter.nuget' }, vscode.TaskScope.Workspace, name, 'NuGet', new vscode.CustomExecution(async () => pty)));
    });
    if (result.code === 0 || !LOCKED.test(result.said) || attempt === 3) return { ...result, attempt };
    onRetry(attempt + 1);
    await new Promise((r) => setTimeout(r, 500));
  }
}

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
    const post = (m) => (m.type === 'dialog' && (panel.dialog = m), panel.webview.postMessage(m)); // the tests read the last dialog

    // What the page shows; the solution's projects are its own, a project page's only that project.
    const solutionProjects = () => {
      if (isProject) return [target];
      const walk = (node) => [...node.projects, ...node.folders.flatMap(walk)];
      return walk(readSolution(target));
    };
    const view = {
      tab: 'installed', query: '', prerelease: false, vulnerableOnly: false, source: undefined, selected: undefined, version: undefined,
      checked: new Set(), status: undefined, paneTab: 'details', transitiveOpen: false,
    };
    let data = { packages: new Map(), projects: [], sources: [], problems: [] };
    let sources = []; // [{ url, name }]
    let mapping = { on: false, mapping: new Map(), files: [] };
    let loading;
    let browsed; // the Browse tab's results
    const meta = new Map(); // source|id -> the search's entry for a package, or null
    const versionInfo = new Map(); // source|id -> { version: details }, or a promise of it
    const readmes = new Map(); // source|id|version -> rendered HTML

    const sourcesFor = () => (view.source === ALL ? sources.map((s) => s.url) : [view.source]);
    const searchIn = (query, prerelease, take) => (view.source === ALL ? feeds.searchAll(sourcesFor(), query, prerelease, take, compareVersions) : feeds.search(view.source, query, prerelease, take, compareVersions));
    const metaOf = (id) => meta.get(`${view.source}|${id.toLowerCase()}`);
    const fetchMeta = async (ids) => {
      const missing = ids.filter((id) => metaOf(id) === undefined);
      // A few at a time: the transitive packages are a hundred or more.
      for (let i = 0; i < missing.length; i += 8) {
        await Promise.all(missing.slice(i, i + 8).map(async (id) => {
          let found = null;
          try {
            found = (await searchIn(`packageid:${id}`, true, 1))?.find((x) => x.id.toLowerCase() === id.toLowerCase()) || null;
          } catch {
            found = null;
          }
          meta.set(`${view.source}|${id.toLowerCase()}`, found);
        }));
      }
    };
    const infoOf = (id) => {
      const key = `${view.source}|${id.toLowerCase()}`;
      const known = versionInfo.get(key);
      return known && !(known instanceof Promise) ? known : undefined;
    };
    const fetchInfo = async (id) => {
      const key = `${view.source}|${id.toLowerCase()}`;
      if (!versionInfo.has(key)) versionInfo.set(key, feeds.versionsOf(sourcesFor(), id, compareVersions).then((v) => (versionInfo.set(key, v), v)));
      return versionInfo.get(key);
    };

    const reload = async () => {
      loading = true;
      show();
      const [read, mapped] = await Promise.all([readInstalled(target, view.prerelease), feeds.readMapping(path.dirname(target))]);
      mapping = mapped;
      // A restore that failed (NU1605, a downgrade a change caused) leaves dotnet list with nothing: the list stays as it
      // was, the error above it.
      data = read.projects.length || !data.projects.length ? read : { ...data, problems: read.problems };
      if (!sources.length || read.projects.length) sources = await feeds.listSources(path.dirname(target), data.sources);
      if (view.source !== ALL && !sources.some((s) => s.url === view.source)) view.source = sources.find((s) => /^https?:/.test(s.url))?.url || sources[0]?.url;
      loading = false;
      show();
      await fetchMeta([...data.packages.values()].filter((p) => p.projects.size || view.transitiveOpen).map((p) => p.id));
      show();
    };

    const browseNow = async () => {
      browsed = undefined;
      show();
      try {
        browsed = (await searchIn(view.query, view.prerelease, 25)) ?? null;
      } catch (e) {
        browsed = [];
        view.status = { text: e.message, error: true };
      }
      for (const x of browsed || []) meta.set(`${view.source}|${x.id.toLowerCase()}`, x);
      show();
    };

    const installedVersions = (pk) => [...new Set([...pk.projects.values()].map((v) => v.resolved))].sort(compareVersions);
    const anyVersions = (pk) => [...new Set([...pk.projects.values(), ...pk.transitive.values()].map((v) => v.resolved))].sort(compareVersions);
    const vulnerableVersions = (pk) => [...pk.advisories.entries()].filter(([, a]) => a.length).map(([v]) => v);
    const deprecatedVersions = (pk) => [...pk.deprecations.keys()];
    const hasUpdate = (pk) => !pk.auto && pk.projects.size > 0 && pk.latest && installedVersions(pk).some((v) => compareVersions(pk.latest, v) > 0);

    /** A list row: what VS shows of a package. */
    const rowOf = (id, found) => {
      const pk = data.packages.get(id.toLowerCase());
      const m = found || metaOf(id);
      const top = pk?.projects.size > 0;
      const versions = pk ? (top ? installedVersions(pk) : anyVersions(pk)) : [];
      return {
        id: pk?.id || m?.id || id,
        authors: m ? [].concat(m.authors || []).join(', ') : '',
        description: m?.description || '',
        icon: m?.iconUrl || '',
        installed: versions.length > 1 ? T.multiple : versions[0] || '',
        transitive: !!pk && !top,
        // Browse shows the source's latest beside what is installed when it is newer, as VS does.
        latest: found && pk ? (versions.length && compareVersions(found.version, versions.at(-1)) > 0 ? found.version : '') : pk ? (hasUpdate(pk) ? pk.latest : '') : m?.version || '',
        update: !!pk && !!hasUpdate(pk),
        upToDate: top && !hasUpdate(pk),
        vulnerable: !!pk && vulnerableVersions(pk).length > 0,
        deprecated: !!pk && deprecatedVersions(pk).length > 0,
      };
    };

    const matching = () => {
      const q = view.query.toLowerCase();
      return [...data.packages.values()].filter((p) => !q || p.id.toLowerCase().includes(q)).sort((a, b) => a.id.localeCompare(b.id));
    };
    const rows = () => {
      const all = matching().filter((p) => p.projects.size);
      if (view.tab === 'browse') return (browsed || []).map((x) => rowOf(x.id, x));
      if (view.tab === 'updates') return all.filter(hasUpdate).map((p) => rowOf(p.id));
      if (view.tab === 'consolidate') return all.filter((p) => installedVersions(p).length > 1).map((p) => rowOf(p.id));
      return all.filter((p) => !view.vulnerableOnly || vulnerableVersions(p).length).map((p) => rowOf(p.id));
    };
    const transitiveRows = () => (view.tab !== 'installed' ? [] : matching().filter((p) => !p.projects.size && p.transitive.size && (!view.vulnerableOnly || vulnerableVersions(p).length)).map((p) => rowOf(p.id)));

    const reasonText = (reasons) => {
      const has = (r) => reasons.some((x) => x.toLowerCase() === r);
      return has('legacy') && has('criticalbugs') ? T.reasonBoth : has('legacy') ? T.reasonLegacy : has('criticalbugs') ? T.reasonCriticalBugs : T.reasonUnknown;
    };

    /** What the package source mapping says of a package, and what installing it from the chosen source does. */
    const mappingOf = (id) => {
      if (!mapping.on) return { text: T.mappingOff, file: mapping.files[0] };
      const mapped = feeds.mappedSources(mapping.mapping, id);
      if (mapped.length) return { text: T.mappingFound, sources: mapped.join(', '), file: mapping.file };
      return { text: T.mappingNotFound, more: view.source === ALL ? T.mappingNeedsSource : T.mappingAuto, file: mapping.file, missing: true };
    };

    /** The selected package's pane: its projects and versions, the versions to pick, its deprecation, advisories,
     *  details or README, and its package source mapping. */
    const details = () => {
      if (!view.selected) return null;
      const pk = data.packages.get(view.selected.toLowerCase());
      const m = metaOf(view.selected) || (browsed || []).find((x) => x.id.toLowerCase() === view.selected.toLowerCase());
      const info = infoOf(view.selected);
      const offered = info ? Object.keys(info) : (m?.versions || []).map((v) => v.version);
      const versions = [...new Set([...offered.filter((v) => view.prerelease || !v.includes('-')), ...(pk ? anyVersions(pk) : [])])].sort(compareVersions).reverse();
      const stable = versions.find((v) => !v.includes('-'));
      const chosen = versions.includes(view.version) ? view.version : (view.version = defaultVersion(pk, versions, stable));
      const at = info?.[chosen];
      // The advisories of the versions installed (dotnet's), and of the chosen one (the feed's).
      const advisories = pk ? vulnerableVersions(pk).flatMap((v) => pk.advisories.get(v).map((a) => ({ version: v, severity: SEVERITY[String(a.severity).toLowerCase()] || 'moderate', url: a.advisoryurl }))) : [];
      if (at && !advisories.some((a) => a.version === chosen)) advisories.push(...at.vulnerabilities.map((a) => ({ version: chosen, severity: SEVERITY[a.severity] || 'moderate', url: a.url })));
      const deprecation = pk?.deprecations.get(chosen) || at?.deprecation;
      const central = [...new Set(solutionProjects().map(centralProps).filter(Boolean))];
      const license = at?.licenseExpression ? { text: at.licenseExpression, url: `https://licenses.nuget.org/${encodeURIComponent(at.licenseExpression)}` } : at?.licenseUrl ? { text: T.viewLicense, url: at.licenseUrl } : null;
      return {
        id: pk?.id || m?.id || view.selected,
        icon: m?.iconUrl || at?.iconUrl || '',
        auto: !!pk?.auto,
        projects: solutionProjects().map((file) => {
          const top = pk?.projects.get(keyOf(file));
          const through = pk?.transitive.get(keyOf(file));
          return { file, name: path.basename(file, path.extname(file)), version: top?.resolved || through?.resolved || '', transitive: !top && !!through, checked: view.checked.has(file) };
        }),
        versions: versions.map((v) => ({ value: v, label: v === versions[0] && v.includes('-') ? `${T.latestPrerelease} ${v}` : v === stable ? `${T.latestStable} ${v}` : v })),
        chosen,
        advisories: advisories.map((a) => ({ ...a, label: T.advisory(T[a.severity]) })),
        deprecation: deprecation ? {
          text: deprecation.alternate ? T.deprecatedUse(deprecation.alternate.id) : T.deprecatedVersion,
          reason: reasonText(deprecation.reasons || []), message: deprecation.message || '', alternate: deprecation.alternate?.id || '',
        } : null,
        paneTab: view.paneTab,
        readme: readmes.get(`${view.source}|${view.selected.toLowerCase()}|${chosen}`),
        description: at?.description || m?.description || '',
        version: chosen || '',
        authors: [].concat(at?.authors || m?.authors || []).join(', '),
        license,
        published: at?.published ? new Date(at.published).toLocaleDateString('pl-PL', { dateStyle: 'long' }) : '',
        downloads: m?.totalDownloads ? m.totalDownloads.toLocaleString('pl-PL') : '',
        projectUrl: at?.projectUrl || m?.projectUrl || '',
        tags: [].concat(at?.tags || m?.tags || []).join(', '),
        dependencies: at ? at.dependencies.filter((g) => g.framework || g.packages.length) : null,
        central: central.length ? T.central(central.map((f) => path.relative(path.dirname(target), f)).join(', ')) : '',
        mapping: mappingOf(pk?.id || m?.id || view.selected),
        showPreview: context.globalState.get('csharpShooter.nuget.showPreview', true),
      };
    };
    const defaultVersion = (pk, versions, stable) => {
      if (pk?.projects.size && view.tab !== 'updates') return installedVersions(pk).at(-1);
      return view.prerelease ? versions[0] : stable || versions[0];
    };

    const show = () => {
      const packages = [...data.packages.values()];
      const vulnerableCount = packages.filter((p) => vulnerableVersions(p).length).length;
      const deprecatedCount = packages.filter((p) => deprecatedVersions(p).length).length;
      const transitive = transitiveRows();
      post((panel.shown = {
        type: 'show',
        tab: view.tab,
        loading: loading || (view.tab === 'browse' && browsed === undefined),
        heading: isProject ? T.projectHeading(name) : T.solutionHeading,
        rows: loading ? [] : rows(),
        transitiveRows: loading ? [] : transitive,
        transitiveOpen: view.transitiveOpen,
        noSearch: view.tab === 'browse' && browsed === null,
        updates: packages.filter(hasUpdate).length,
        consolidate: packages.filter((p) => installedVersions(p).length > 1).length,
        vulnerableCount,
        deprecatedCount,
        banner: vulnerableCount && deprecatedCount ? T.bothWarning(vulnerableCount, deprecatedCount) : vulnerableCount ? T.vulnerableWarning(vulnerableCount) : deprecatedCount ? T.deprecatedWarning(deprecatedCount) : '',
        sources: [...(sources.length > 1 ? [{ value: ALL, label: T.allSources }] : []), ...sources.map((s) => ({ value: s.url, label: s.name }))],
        source: view.source,
        selected: view.selected,
        details: details(),
        status: data.problems.length && !view.status?.busy ? { text: data.problems[0], error: true } : view.status,
        legal: !context.globalState.get('csharpShooter.nuget.hideLegal'),
        prerelease: view.prerelease,
        vulnerableOnly: view.vulnerableOnly,
      }));
    };

    const loadReadme = async () => {
      const id = view.selected;
      const version = view.version;
      const key = `${view.source}|${id?.toLowerCase()}|${version}`;
      if (!id || !version || readmes.has(key)) return;
      const info = await fetchInfo(id);
      let html = '';
      try {
        const text = info[version] ? await feeds.readmeOf(info[version]) : '';
        html = await vscode.commands.executeCommand('markdown.api.render', text || T.noReadme);
      } catch {
        html = '';
      }
      readmes.set(key, html || T.noReadme);
      show();
    };

    /** VS's Preview Changes: what each project gets, as VS lists it. */
    const previewOf = (plan) => {
      const projects = new Map();
      for (const p of plan) {
        const name = path.basename(p.file, path.extname(p.file));
        if (!projects.has(name)) projects.set(name, { name, installing: [], updates: [], uninstalling: [] });
        const entry = projects.get(name);
        if (p.action === 'uninstall') entry.uninstalling.push(`${p.id} ${p.from}`);
        else if (p.from) entry.updates.push(T.previewUpdate(p.id, p.from, p.id, p.to));
        else entry.installing.push(`${p.id} ${p.to}`);
      }
      return [...projects.values()].map((p) => ({
        name: p.name,
        sections: [[T.installing, p.installing], [T.updatesColon, p.updates], [T.uninstalling, p.uninstalling]].filter(([, items]) => items.length).map(([label, items]) => ({ label, items })),
      }));
    };

    /** Runs a plan of changes ({ file, id, from, to, action }), as VS does: Preview Changes first (when its option is
     *  on), then License Acceptance for a package that asks for it, a package source mapping added for an unmapped
     *  package, then dotnet add/remove package for each, a restore, and the packages read again. `asked` carries what
     *  the person already answered. */
    const apply = async (plan, asked, again) => {
      plan = plan.filter((p) => p.id && !p.id.startsWith('-') && (p.action === 'uninstall' || (p.to && !p.to.startsWith('-')))); // an id or version read as an option
      if (!plan.length) return undefined;
      const installs = plan.filter((p) => p.action !== 'uninstall');
      const unmapped = mapping.on ? [...new Set(installs.map((p) => p.id))].filter((id) => !feeds.mappedSources(mapping.mapping, id).length) : [];
      if (unmapped.length && view.source === ALL) {
        view.status = { text: `${T.mappingNotFound} ${T.mappingNeedsSource}`, error: true };
        return show();
      }
      const sourceName = sources.find((s) => s.url === view.source)?.name || view.source;
      if (context.globalState.get('csharpShooter.nuget.showPreview', true) && !asked.previewed) {
        post({
          type: 'dialog', title: T.previewTitle, preview: previewOf(plan),
          note: unmapped.length ? `${T.creatingMappings(sourceName)} ${unmapped.join(', ')}` : '',
          buttons: [{ label: T.ok, primary: true, answer: { ...again, previewed: true } }, { label: T.cancel }],
        });
        return undefined;
      }
      if (installs.length && !asked.accepted) {
        const needs = [];
        for (const p of installs) {
          const at = (await fetchInfo(p.id).catch(() => ({})))[p.to];
          if (at?.requireLicenseAcceptance && !needs.some((n) => n.id === p.id)) {
            needs.push({ id: p.id, version: p.to, authors: [].concat(at.authors || []).join(', '), url: at.licenseExpression ? `https://licenses.nuget.org/${encodeURIComponent(at.licenseExpression)}` : at.licenseUrl });
          }
        }
        if (needs.length) {
          post({
            type: 'dialog', title: T.licenseTitle, header: T.licenseHeader, licenses: needs, footer: T.licenseText,
            buttons: [{ label: T.accept, primary: true, answer: { ...again, previewed: true, accepted: true } }, { label: T.decline, declined: true }],
          });
          return undefined;
        }
      }
      for (const id of unmapped) feeds.addMapping(mapping.file, sourceName, id);
      const codes = [];
      const attempts = [];
      for (const p of plan) {
        const args = p.action === 'uninstall' ? ['remove', p.file, 'package', p.id] : ['add', p.file, 'package', p.id, '--version', p.to];
        view.status = { text: T.working(args.join(' ')), busy: true };
        show();
        const r = await dotnetTask(`NuGet: ${path.basename(p.file, path.extname(p.file))}`, args, path.dirname(p.file), (n) => {
          view.status = { text: T.retrying(n), busy: true };
          show();
        });
        codes.push(r.code);
        attempts.push(r.attempt);
      }
      // dotnet add restores the project alone, and the C# server may restore it as the file changes: the solution is
      // restored once more, so dotnet list reads whole assets (Passenger restores after a set of changes too).
      view.status = { text: T.working('restore'), busy: true };
      show();
      await dotnetTask(`NuGet: restore ${name}`, ['restore', target], path.dirname(target));
      const bad = codes.find((c) => c !== 0);
      view.status = bad === undefined ? { text: T.done, ok: true } : { text: T.failed(bad), error: true };
      state.last = { codes, attempts, plan };
      await reload();
      return state.last;
    };

    const select = async (id) => {
      view.selected = id;
      view.version = undefined;
      const pk = data.packages.get(id.toLowerCase());
      view.checked = new Set(isProject ? [target] : solutionProjects().filter((f) => pk?.projects.has(keyOf(f))));
      show();
      await Promise.all([fetchMeta([id]), fetchInfo(id)]);
      show();
      if (view.paneTab === 'readme') await loadReadme();
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
      if (m.type === 'transitiveOpen') {
        view.transitiveOpen = !!m.value;
        show();
        if (view.transitiveOpen) await fetchMeta([...data.packages.values()].filter((p) => !p.projects.size).map((p) => p.id));
      }
      if (m.type === 'source') {
        view.source = m.source;
        if (view.tab === 'browse') browseNow();
        show();
        await fetchMeta([...data.packages.values()].filter((p) => p.projects.size || view.transitiveOpen).map((p) => p.id));
        if (view.selected) await fetchInfo(view.selected);
      }
      if (m.type === 'refresh') {
        feeds.folderIndexes.clear();
        meta.clear();
        versionInfo.clear();
        if (view.tab === 'browse') browseNow();
        return reload();
      }
      if (m.type === 'select') return select(m.id);
      if (m.type === 'version') {
        view.version = m.version;
        if (view.paneTab === 'readme') {
          show();
          return loadReadme();
        }
      }
      if (m.type === 'paneTab') {
        view.paneTab = m.tab;
        show();
        if (m.tab === 'readme') return loadReadme();
      }
      if (m.type === 'check') {
        for (const file of m.files) m.value ? view.checked.add(file) : view.checked.delete(file);
      }
      if (m.type === 'showPreview') await context.globalState.update('csharpShooter.nuget.showPreview', !!m.value);
      if (m.type === 'install' && view.selected && m.version) {
        const pk = data.packages.get(view.selected.toLowerCase());
        const id = pk?.id || metaOf(view.selected)?.id || view.selected;
        const plan = [...view.checked].filter((f) => pk?.projects.get(keyOf(f))?.resolved !== m.version)
          .map((f) => ({ file: f, id, from: pk?.projects.get(keyOf(f))?.resolved || '', to: m.version, action: 'install' }));
        return apply(plan, m, m);
      }
      if (m.type === 'uninstall' && view.selected) {
        const pk = data.packages.get(view.selected.toLowerCase());
        const plan = [...view.checked].filter((f) => pk?.projects.has(keyOf(f))).map((f) => ({ file: f, id: pk.id, from: pk.projects.get(keyOf(f)).resolved, action: 'uninstall' }));
        return apply(plan, m, m);
      }
      if (m.type === 'updateAll') {
        const plan = [];
        for (const id of m.ids) {
          const pk = data.packages.get(id.toLowerCase());
          if (!pk || !hasUpdate(pk)) continue;
          for (const v of pk.projects.values()) if (compareVersions(pk.latest, v.resolved) > 0) plan.push({ file: v.file, id: pk.id, from: v.resolved, to: pk.latest, action: 'install' });
        }
        return apply(plan, m, m);
      }
      if (m.type === 'declined') view.status = { text: T.declined };
      if (m.type === 'hideLegal') await context.globalState.update('csharpShooter.nuget.hideLegal', true);
      if (m.type === 'link' && /^https?:/i.test(m.url)) return vscode.env.openExternal(vscode.Uri.parse(m.url));
      if (m.type === 'openFile' && m.file && [...mapping.files].some((f) => keyOf(f) === keyOf(m.file))) return vscode.window.showTextDocument(vscode.Uri.file(m.file));
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
      by: T.by('{0}'), topLevel: T.topLevel('{0}'), transitive: T.transitive('{0}'), transitiveLevel: T.transitiveLevel, transitiveVersion: T.transitiveVersion('{0}'),
      loading: T.loading, noPackages: T.noPackages, updateAvailable: T.updateAvailable, latestInstalled: T.latestInstalled, installedVersion: T.installedVersion('{0}'),
      vulnerable: T.vulnerable, deprecated: T.deprecated, selectAllProjects: T.selectAllProjects, selectAllPackages: T.selectAllPackages, project: T.project,
      installedColumn: T.installedColumn, version: T.version, install: T.install, update: T.update, uninstall: T.uninstall, packageDetails: T.packageDetails,
      readme: T.readme, loadingReadme: T.loadingReadme, description: T.description, versionLabel: T.version, authors: T.authors, license: T.license,
      published: T.published, downloads: T.downloads, projectUrl: T.projectUrl, tags: T.tags, dependencies: T.dependencies, noDependencies: T.noDependencies,
      vulnerabilities: T.vulnerabilities('{0}'), deprecationReason: T.deprecationReason, alternate: T.alternate, autoReferenced: T.autoReferenced,
      options: T.options, showPreview: T.showPreview, configure: T.configure, noSearch: T.noSearch,
    };
    // A package without an icon gets NuGet's default: a blue box.
    const defaultIcon = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#1e88e5" d="M16 2 3 8v16l13 6 13-6V8z"/><path fill="#90caf9" d="M16 2 3 8l13 6 13-6z"/></svg>')}`;
    return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); --accent: var(--vscode-textLink-foreground);
    --warn: var(--vscode-editorWarning-foreground, #cca700); }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .head { display: flex; align-items: center; gap: 28px; padding: 14px 20px 6px; }
  .tab { cursor: pointer; font-size: 1.15em; padding: 2px 0; border-bottom: 2px solid transparent; user-select: none; }
  .tab.on { color: var(--accent); border-color: var(--accent); }
  .tab .badge { font-size: .75em; padding: 0 4px; margin-left: 4px; color: #fff; background: var(--vscode-activityBarBadge-background, #0078d4); }
  .tab .warn { color: var(--warn); margin-left: 4px; }
  .heading { margin-left: auto; font-size: 1.35em; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 20px 10px; flex-wrap: wrap; }
  input[type=text], select { font: inherit; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); max-width: 320px; }
  #query { width: 300px; }
  .icon-btn { cursor: pointer; background: none; border: 0; color: inherit; font-size: 1.1em; padding: 2px 6px; }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  label.check { display: flex; gap: 6px; align-items: center; }
  .right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .banner { display: flex; align-items: center; gap: 8px; padding: 5px 20px; color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
  .banner .text { color: var(--vscode-foreground); }
  .banner .close { margin-left: auto; }
  .main { flex: 1; display: flex; min-height: 0; border-top: 1px solid var(--line); }
  .list { flex: 1; overflow: auto; border-right: 1px solid var(--line); }
  .pane { flex: 1; overflow: auto; padding: 14px 18px; }
  .group { padding: 8px 12px 4px; display: flex; gap: 6px; align-items: center; user-select: none; }
  .group.toggle { cursor: pointer; }
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
  .muted { color: var(--muted); }
  .warnIcon { color: var(--warn); margin-right: 4px; }
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
  .box { border-left: 3px solid var(--warn); padding: 6px 10px; margin: 10px 0; background: var(--vscode-textBlockQuote-background); }
  a { color: var(--accent); cursor: pointer; text-decoration: none; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .note { color: var(--muted); margin: 6px 0; }
  .paneTabs { display: flex; gap: 18px; margin: 14px 0 10px; border-bottom: 1px solid var(--line); }
  .paneTabs span { cursor: pointer; padding: 4px 0; border-bottom: 2px solid transparent; }
  .paneTabs span.on { color: var(--accent); border-color: var(--accent); }
  .deps { margin: 0; padding-left: 18px; }
  .readme img { max-width: 100%; }
  .readme pre { overflow: auto; padding: 8px; background: var(--vscode-textCodeBlock-background); }
  details summary { cursor: pointer; margin: 10px 0 4px; }
  .modal { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; z-index: 5; }
  .modal .win { width: min(560px, 92vw); max-height: 80vh; overflow: auto; padding: 16px 20px; color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--line); box-shadow: 0 4px 16px #0008; }
  .modal h3 { margin: 0 0 12px; font-size: 1.2em; }
  .modal .proj { font-weight: 600; margin-top: 10px; }
  .modal ul { margin: 2px 0 6px; padding-left: 20px; }
  .modal .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
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
<div class="modal" id="modal" hidden><div class="win" id="win"></div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const T = ${JSON.stringify(texts)};
  const fill = (s, v) => s.replace('{0}', v);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const DEFAULT_ICON = ${JSON.stringify(defaultIcon)};
  const img = (src) => '<img src="' + esc(src || DEFAULT_ICON) + '" data-fallback="1" alt="">';
  let m, bannerClosed = false, topOpen = true;
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
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('query').focus(); $('query').select(); }
    if (e.key === 'Escape' && !$('modal').hidden) $('modal').hidden = true;
  });
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.dataset.fallback) { e.target.dataset.fallback = ''; e.target.src = DEFAULT_ICON; } }, true);
  // Links (a package's pages, a README's) open in the browser; a deprecation's alternate package is selected.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.select) send({ type: 'select', id: a.dataset.select });
    else if (a.dataset.file) send({ type: 'openFile', file: a.dataset.file });
    else if (a.dataset.url || /^https?:/i.test(a.getAttribute('href') || '')) send({ type: 'link', url: a.dataset.url || a.getAttribute('href') });
  });

  function rowHtml(r) {
    const over = r.update ? '<span class="over up" title="' + esc(T.updateAvailable) + '">↑</span>' : r.upToDate ? '<span class="over ok" title="' + esc(T.latestInstalled) + '">✓</span>' : '';
    const pick = m.tab === 'updates' ? '<input type="checkbox" class="pick" data-id="' + esc(r.id) + '"' + (picked.has(r.id) ? ' checked' : '') + '>' : '';
    const warn = r.vulnerable ? '<span class="warnIcon" title="' + esc(T.vulnerable) + '">⚠</span>' : r.deprecated ? '<span class="warnIcon" title="' + esc(T.deprecated) + '">⚠</span>' : '';
    const tip = r.transitive ? fill(T.transitiveVersion, r.installed) : fill(T.installedVersion, r.installed);
    return '<div class="row' + (m.selected && m.selected.toLowerCase() === r.id.toLowerCase() ? ' on' : '') + '" data-id="' + esc(r.id) + '">' + pick
      + '<div class="ic">' + img(r.icon) + over + '</div>'
      + '<div class="what"><div class="title" title="' + esc(r.id) + '"><span class="name">' + esc(r.id) + '</span>' + (r.authors ? '<span class="by">' + esc(fill(T.by, r.authors)) + '</span>' : '') + '</div>'
      + '<div class="desc">' + esc(r.description) + '</div></div>'
      + '<div class="ver">' + (r.installed ? '<span title="' + esc(tip) + '"' + (r.transitive ? ' class="muted"' : '') + '>' + warn + esc(r.installed) + '</span>' : '')
      + (r.latest ? '<span class="' + (r.installed ? 'newer' : '') + '">' + esc(r.latest) + '</span>' : '') + '</div></div>';
  }

  function detailsHtml(d) {
    let h = '';
    if (d.deprecation) {
      h += '<div class="box"><b>' + esc(T.deprecated) + '</b><div>' + esc(d.deprecation.text) + '</div>'
        + '<div><span class="muted">' + esc(T.deprecationReason) + ':</span> ' + esc(d.deprecation.reason) + (d.deprecation.message ? ' ' + esc(d.deprecation.message) : '') + '</div>'
        + (d.deprecation.alternate ? '<div><span class="muted">' + esc(T.alternate) + ':</span> <a data-select="' + esc(d.deprecation.alternate) + '">' + esc(d.deprecation.alternate) + '</a></div>' : '') + '</div>';
    }
    if (d.advisories.length) {
      h += '<div class="box"><b>' + esc(fill(T.vulnerabilities, d.advisories.length)) + '</b>'
        + d.advisories.map((a) => '<div>' + esc(a.version) + ' – ' + esc(a.label) + ' <a data-url="' + esc(a.url) + '">' + esc(a.url) + '</a></div>').join('') + '</div>';
    }
    h += '<dl>';
    if (d.description) h += '<dt>' + esc(T.description) + '</dt><dd>' + esc(d.description) + '</dd>';
    if (d.version) h += '<dt>' + esc(T.versionLabel) + '</dt><dd>' + esc(d.version) + '</dd>';
    if (d.authors) h += '<dt>' + esc(T.authors) + '</dt><dd>' + esc(d.authors) + '</dd>';
    if (d.license) h += '<dt>' + esc(T.license) + '</dt><dd><a data-url="' + esc(d.license.url) + '">' + esc(d.license.text) + '</a></dd>';
    if (d.published) h += '<dt>' + esc(T.published) + '</dt><dd>' + esc(d.published) + '</dd>';
    if (d.downloads) h += '<dt>' + esc(T.downloads) + '</dt><dd>' + esc(d.downloads) + '</dd>';
    if (d.projectUrl) h += '<dt>' + esc(T.projectUrl) + '</dt><dd><a data-url="' + esc(d.projectUrl) + '">' + esc(d.projectUrl) + '</a></dd>';
    if (d.tags) h += '<dt>' + esc(T.tags) + '</dt><dd>' + esc(d.tags) + '</dd>';
    h += '</dl>';
    if (d.dependencies) {
      h += '<h3>' + esc(T.dependencies) + '</h3>';
      h += d.dependencies.length ? d.dependencies.map((g) => '<div>' + esc(g.framework) + '</div><ul class="deps">'
        + (g.packages.length ? g.packages.map((p) => '<li>' + esc(p.id) + ' (' + esc(p.range) + ')</li>').join('') : '<li class="muted">' + esc(T.noDependencies) + '</li>') + '</ul>').join('')
        : '<div class="muted">' + esc(T.noDependencies) + '</div>';
    }
    return h;
  }

  function paneHtml(d) {
    if (!d) return '';
    const canChange = !d.auto;
    const all = d.projects.length && d.projects.every((p) => p.checked);
    let h = '<h2>' + img(d.icon) + esc(d.id) + '</h2>';
    if (d.auto) h += '<div class="note">' + esc(T.autoReferenced) + '</div>';
    h += '<table><tr><th><input type="checkbox" id="allProjects"' + (all ? ' checked' : '') + ' title="' + esc(T.selectAllProjects) + '"></th><th>' + esc(T.project) + '</th><th>' + esc(T.installedColumn) + '</th></tr>'
      + d.projects.map((p) => '<tr><td><input type="checkbox" class="proj" data-file="' + esc(p.file) + '"' + (p.checked ? ' checked' : '') + '></td><td>' + esc(p.name) + '</td><td'
        + (p.transitive ? ' class="muted" title="' + esc(fill(T.transitiveVersion, p.version)) + '">' + esc(p.version) + ' (' + esc(T.transitiveLevel) + ')' : '>' + esc(p.version)) + '</td></tr>').join('') + '</table>';
    if (d.central) h += '<div class="note">' + esc(d.central) + '</div>';
    h += '<div class="actions"><label for="version">' + esc(T.version) + '</label><select id="version">'
      + d.versions.map((v) => '<option value="' + esc(v.value) + '"' + (v.value === d.chosen ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('') + '</select>'
      + '<button class="primary" id="install"' + (canChange ? '' : ' disabled') + '>' + esc(m.tab === 'updates' ? T.update : T.install) + '</button>'
      + '<button id="uninstall"' + (canChange && d.projects.some((p) => p.checked && p.version && !p.transitive) ? '' : ' disabled') + '>' + esc(T.uninstall) + '</button></div>';
    h += '<div class="note">' + esc(d.mapping.text) + (d.mapping.sources ? ' (' + esc(d.mapping.sources) + ')' : '') + (d.mapping.more ? ' ' + esc(d.mapping.more) : '')
      + (d.mapping.file ? ' <a data-file="' + esc(d.mapping.file) + '">' + esc(T.configure) + '</a>' : '') + '</div>';
    h += '<details' + (optionsOpen ? ' open' : '') + ' id="options"><summary>' + esc(T.options) + '</summary><label class="check"><input type="checkbox" id="showPreview"' + (d.showPreview ? ' checked' : '') + '> ' + esc(T.showPreview) + '</label></details>';
    h += '<div class="paneTabs"><span data-pane="details"' + (d.paneTab === 'details' ? ' class="on"' : '') + '>' + esc(T.packageDetails) + '</span><span data-pane="readme"' + (d.paneTab === 'readme' ? ' class="on"' : '') + '>' + esc(T.readme) + '</span></div>';
    h += d.paneTab === 'readme' ? '<div class="readme">' + (d.readme ?? '<div class="muted">' + esc(T.loadingReadme) + '</div>') + '</div>' : detailsHtml(d);
    return h;
  }
  let optionsOpen = false;

  function group(label, open, id) {
    return '<div class="group toggle" id="' + id + '">' + (open ? '⌃' : '⌄') + ' ' + esc(label) + '</div>';
  }

  function render() {
    document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === m.tab));
    $('heading').textContent = m.heading;
    $('installedWarn').hidden = !m.vulnerableCount && !m.deprecatedCount;
    $('updatesBadge').hidden = !m.updates; $('updatesBadge').textContent = m.updates;
    $('consolidateBadge').hidden = !m.consolidate; $('consolidateBadge').textContent = m.consolidate;
    $('banner').hidden = bannerClosed || !m.banner;
    $('bannerText').textContent = m.banner;
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
    else if (!m.rows.length && !m.transitiveRows.length) list = '<div class="empty">' + esc(T.noPackages) + '</div>';
    else {
      if (m.tab === 'updates') list += '<div class="group"><label class="check"><input type="checkbox" id="allPackages"' + (m.rows.every((r) => picked.has(r.id)) ? ' checked' : '') + '> ' + esc(T.selectAllPackages) + '</label><button class="primary" id="updateAll"' + (picked.size ? '' : ' disabled') + '>' + esc(T.update) + '</button></div>';
      if (m.tab === 'browse') list += m.rows.map(rowHtml).join('');
      else {
        list += group(fill(T.topLevel, m.rows.length), topOpen, 'topGroup') + (topOpen ? m.rows.map(rowHtml).join('') : '');
        if (m.transitiveRows.length) list += group(fill(T.transitive, m.transitiveRows.length), m.transitiveOpen, 'transitiveGroup') + (m.transitiveOpen ? m.transitiveRows.map(rowHtml).join('') : '');
      }
    }
    const scroll = $('list').scrollTop;
    $('list').innerHTML = list;
    $('list').scrollTop = scroll;
    const paneScroll = $('pane').scrollTop;
    $('pane').innerHTML = paneHtml(m.details);
    $('pane').scrollTop = paneScroll;
    if ($('topGroup')) $('topGroup').onclick = () => { topOpen = !topOpen; render(); };
    if ($('transitiveGroup')) $('transitiveGroup').onclick = () => send({ type: 'transitiveOpen', value: !m.transitiveOpen });
    $('list').querySelectorAll('.row').forEach((el) => el.onclick = (e) => { if (!e.target.classList.contains('pick')) send({ type: 'select', id: el.dataset.id }); });
    $('list').querySelectorAll('.pick').forEach((el) => el.onchange = () => { el.checked ? picked.add(el.dataset.id) : picked.delete(el.dataset.id); render(); });
    if ($('allPackages')) $('allPackages').onchange = () => { m.rows.forEach((r) => $('allPackages').checked ? picked.add(r.id) : picked.delete(r.id)); render(); };
    if ($('updateAll')) $('updateAll').onclick = () => send({ type: 'updateAll', ids: [...picked] });
    if (!m.details) return;
    $('pane').querySelectorAll('.proj').forEach((el) => el.onchange = () => send({ type: 'check', files: [el.dataset.file], value: el.checked }));
    $('allProjects').onchange = () => send({ type: 'check', files: m.details.projects.map((p) => p.file), value: $('allProjects').checked });
    $('version').onchange = () => send({ type: 'version', version: $('version').value });
    $('install').onclick = () => send({ type: 'install', version: $('version').value });
    $('uninstall').onclick = () => send({ type: 'uninstall' });
    $('options').ontoggle = () => { optionsOpen = $('options').open; };
    $('showPreview').onchange = () => send({ type: 'showPreview', value: $('showPreview').checked });
    $('pane').querySelectorAll('.paneTabs span').forEach((el) => el.onclick = () => send({ type: 'paneTab', tab: el.dataset.pane }));
  }

  // VS's dialogs: Preview Changes and License Acceptance; a button answers with the request to run again, or declines.
  function dialog(d) {
    let h = '<h3>' + esc(d.title) + '</h3>';
    if (d.header) h += '<p>' + esc(d.header) + '</p>';
    for (const p of d.preview || []) {
      h += '<div class="proj">' + esc(p.name) + '</div>' + p.sections.map((s) => '<div>' + esc(s.label) + '</div><ul>' + s.items.map((i) => '<li>' + esc(i) + '</li>').join('') + '</ul>').join('');
    }
    for (const l of d.licenses || []) {
      h += '<div class="proj">' + esc(l.id) + ' ' + esc(l.version) + '</div><div class="muted">' + esc(fill(T.by, l.authors)) + '</div>' + (l.url ? '<a data-url="' + esc(l.url) + '">' + esc(T.license.replace(':', '')) + '</a>' : '');
    }
    if (d.note) h += '<p>' + esc(d.note) + '</p>';
    if (d.footer) h += '<p>' + esc(d.footer) + '</p>';
    h += '<div class="buttons">' + d.buttons.map((b, i) => '<button data-i="' + i + '"' + (b.primary ? ' class="primary"' : '') + '>' + esc(b.label) + '</button>').join('') + '</div>';
    $('win').innerHTML = h;
    $('modal').hidden = false;
    $('win').querySelectorAll('.buttons button').forEach((el) => el.onclick = () => {
      $('modal').hidden = true;
      const b = d.buttons[Number(el.dataset.i)];
      if (b.answer) send(b.answer);
      else if (b.declined) send({ type: 'declined' });
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.data.type === 'show') { m = ev.data; render(); }
    if (ev.data.type === 'dialog') dialog(ev.data);
  });
  send({ type: 'ready' });
</script></body></html>`;
  }

  return { open, pages, state, compareVersions, readInstalled };
}

module.exports = { registerNuGetPage, compareVersions };
