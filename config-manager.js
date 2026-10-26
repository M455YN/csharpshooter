// Visual Studio's Configuration Manager (the solution's context menu, or the end of the status bar's configuration and
// platform lists) in an editor tab: the active solution configuration and platform (the status bar's), and for them each
// project's configuration, platform, Kompilacja and Wdróż, with Kompiluj wszystko / Wdróż wszystko; <Nowy...> and
// <Edytuj...> for the solution's configurations and platforms and for each project's. The solution is written as VS
// writes it (solution-config.js), a project's own configurations and platforms in its <Configurations> / <Platforms>.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { table } = require('./l10n');
const config = require('./solution-config');
const r = require('./property-rules');

// VS's own words for these (msenvui.dll), in English and Polish (l10n/pl.json).
const T = table({
  title: 'Configuration Manager',
  activeConfiguration: 'Active solution configuration:',
  activePlatform: 'Active solution platform:',
  contexts: 'Project contexts (check the project configurations to build or deploy):',
  project: 'Project',
  configuration: 'Configuration',
  platform: 'Platform',
  build: 'Build',
  deploy: 'Deploy',
  buildAll: 'Build all',
  deployAll: 'Deploy all',
  close: 'Close',
  newItem: '<New...>',
  editItem: '<Edit...>',
  empty: '<Empty>',
  newSolutionConfiguration: 'New Solution Configuration',
  newProjectConfiguration: 'New Project Configuration',
  newSolutionPlatform: 'New Solution Platform',
  newProjectPlatform: 'New Project Platform',
  editSolutionConfigurations: 'Edit Solution Configurations',
  editProjectConfigurations: 'Edit Project Configurations',
  editSolutionPlatforms: 'Edit Solution Platforms',
  editProjectPlatforms: 'Edit Project Platforms',
  name: 'Name:',
  platforms: 'Platforms:',
  newPlatform: 'New platform:',
  typePlatform: 'Type or select the new platform:',
  copyFrom: 'Copy settings from:',
  createProjectConfigurations: 'Create new project configurations',
  createSolutionConfigurations: 'Create new solution configurations',
  createProjectPlatforms: 'Create new project platforms',
  createSolutionPlatforms: 'Create new solution platforms',
  remove: 'Remove',
  rename: 'Rename',
  ok: 'OK',
  cancel: 'Cancel',
  exists: 'The name "{0}" is already used.',
  invalid: 'The name cannot be empty or contain | * " < >.',
  last: 'The last one cannot be removed.',
  noSolution: 'There is no solution in this workspace.',
  loading: 'Reading the projects…',
});

// What VS's New Platform lists offer.
const SOLUTION_PLATFORMS = ['Any CPU', 'x86', 'x64', 'ARM32', 'ARM64'];
const PROJECT_PLATFORMS = ['AnyCPU', 'x86', 'x64', 'ARM32', 'ARM64'];
const shown = (p) => (p === 'AnyCPU' ? 'Any CPU' : p);
const lower = (list) => list.map((x) => x.toLowerCase().replace(/\s/g, ''));

/** A project's own configurations and platforms, as MSBuild has them (Configurations, Platforms). */
function projectLists(file) {
  return new Promise((resolve) => execFile('dotnet', ['msbuild', file, '-getProperty:Configurations', '-getProperty:Platforms'],
    { cwd: path.dirname(file), windowsHide: true }, (error, stdout) => {
      let p = {};
      try { p = JSON.parse(stdout).Properties || {}; } catch { /* a project MSBuild cannot read: VS's defaults */ }
      const split = (v, d) => (v || d).split(';').map((s) => s.trim()).filter(Boolean);
      resolve({ buildTypes: split(p.Configurations, 'Debug;Release'), platforms: split(p.Platforms, 'AnyCPU') });
    }));
}

function registerConfigurationManager(context, findSolution, startup) {
  let panel;
  const lists = new Map(); // project file -> { mtime, buildTypes, platforms }
  const listsOf = async (file) => {
    const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    const cached = lists.get(file);
    if (cached?.mtime === mtime) return cached;
    const next = { mtime, ...(await projectLists(file)) };
    lists.set(file, next);
    return next;
  };

  const open = async () => {
    if (panel) {
      panel.reveal();
      return panel;
    }
    panel = vscode.window.createWebviewPanel('csharpShooter.configurationManager', T.title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = new vscode.ThemeIcon('settings');
    panel.onDidDispose(() => { panel = undefined; });
    const post = (m) => panel?.webview.postMessage(m);
    const error = (text) => post({ type: 'error', text });

    const load = async () => {
      const settings = await startup.solutionSettings();
      if (!settings.solution) return undefined;
      const model = config.read(settings.solution);
      await Promise.all(model.projects.map(async (p) => { p.lists = await listsOf(p.file); }));
      return { model, settings };
    };
    const show = async () => {
      const state = await load();
      if (!state) return error(T.noSolution);
      const { model, settings } = state;
      const k = config.key(settings.configuration, settings.platform);
      panel.state = state;
      post({
        type: 'show',
        configuration: settings.configuration,
        platform: settings.platform,
        configurations: model.buildTypes,
        platforms: model.platforms,
        projects: model.projects.map((p) => {
          const c = p.cells.get(k);
          return { path: p.path, name: path.basename(p.path).replace(/\.[^.]+$/, ''), buildType: c.buildType, platform: c.platform, build: c.build, deploy: c.deploy,
            buildTypes: p.lists.buildTypes, platforms: p.lists.platforms };
        }),
      });
      return undefined;
    };
    const save = (model) => {
      const text = config.write(model);
      if (text !== model.text) fs.writeFileSync(model.file, text);
      startup.changed.fire(); // the status bar's lists
    };
    const editProject = (project, change) => {
      const text = fs.readFileSync(project.file, 'utf8');
      const next = change(text);
      if (next !== text) fs.writeFileSync(project.file, next);
    };
    const property = (kind) => (kind === 'buildTypes' ? 'Configurations' : 'Platforms');
    const dimension = (kind) => (kind === 'buildTypes' ? 'buildType' : 'platform');
    const writeList = (project, kind, list) => editProject(project, (text) => r.writeProperty(text, property(kind), list.join(';'), '', ''));
    const valid = (name, taken) => {
      if (!name || /[|*"<>]/.test(name)) return T.invalid;
      return lower(taken).includes(name.toLowerCase().replace(/\s/g, '')) ? T.exists(name) : undefined;
    };
    /** A project's new configuration or platform: in its project file (the groups of `from` copied), and in its cells. */
    const addToProject = (project, kind, name, from) => {
      writeList(project, kind, [...project.lists[kind], name]);
      if (from) editProject(project, (text) => config.conditionedGroups(text, dimension(kind), from, name, 'copy'));
      project.lists[kind] = [...project.lists[kind], name];
    };

    const request = (panel.request = async (m) => {
      if (m.type === 'ready') return show();
      const state = await load();
      if (!state) return error(T.noSolution);
      const { model, settings } = state;
      const k = config.key(settings.configuration, settings.platform);
      const project = model.projects.find((p) => p.path === m.project);
      if (m.type === 'active') {
        await startup.setSolutionSettings({ [m.kind === 'buildTypes' ? 'configuration' : 'platform']: m.value });
      }
      if (m.type === 'cell' && project) {
        project.cells.set(k, { ...project.cells.get(k), ...m.change });
        save(model);
      }
      if (m.type === 'all') {
        for (const p of model.projects) p.cells.set(k, { ...p.cells.get(k), [m.dimension]: m.value });
        save(model);
      }
      if (m.type === 'newSolution') {
        const problem = valid(m.name, model[m.kind]);
        if (problem) return error(problem);
        config.addSolution(model, m.kind, m.name, m.from || null, (p, copied) => {
          const own = p.lists[m.kind];
          const has = lower(own).includes(m.name.toLowerCase().replace(/\s/g, ''));
          if (m.kind === 'buildTypes') {
            if (m.create) {
              if (!has) addToProject(p, m.kind, m.name, copied.buildType);
              return { buildType: m.name };
            }
            return m.from ? {} : { buildType: has ? m.name : own[0] };
          }
          // A platform: projects keep the copied (or default: AnyCPU) one unless new project platforms are made.
          const projectName = config.canonical(m.name).replace(/\s/g, '');
          if (!m.create) return {};
          if (!lower(own).includes(projectName.toLowerCase())) addToProject(p, m.kind, projectName, copied.platform);
          return { platform: projectName };
        });
        save(model);
        await startup.setSolutionSettings({ [m.kind === 'buildTypes' ? 'configuration' : 'platform']: m.name });
      }
      if (m.type === 'newProject' && project) {
        const name = m.kind === 'platforms' ? m.name.replace(/\s/g, '') : m.name;
        const problem = valid(name, project.lists[m.kind]);
        if (problem) return error(problem);
        addToProject(project, m.kind, name, m.from);
        const solutionName = m.kind === 'platforms' ? shown(name) : name;
        if (m.create && !lower(model[m.kind]).includes(solutionName.toLowerCase().replace(/\s/g, ''))) {
          const active = m.kind === 'buildTypes' ? settings.configuration : settings.platform;
          config.addSolution(model, m.kind, solutionName, active, (p) => (p === project ? { [dimension(m.kind)]: name } : {}));
        }
        project.cells.set(k, { ...project.cells.get(k), [dimension(m.kind)]: name });
        save(model);
      }
      if (m.type === 'edit') {
        const own = m.project ? project?.lists[m.kind] : model[m.kind];
        if (!own) return undefined;
        if (m.op === 'remove') {
          if (own.length < 2) return error(T.last);
          if (m.project) {
            const rest = own.filter((x) => x !== m.name);
            writeList(project, m.kind, rest);
            project.lists[m.kind] = rest;
            config.renameProject(project, dimension(m.kind), m.name, rest[0]);
          } else config.removeSolution(model, m.kind, m.name);
        }
        if (m.op === 'rename') {
          const to = m.project && m.kind === 'platforms' ? m.to.replace(/\s/g, '') : m.to;
          const problem = valid(to, own.filter((x) => x !== m.name));
          if (problem) return error(problem);
          if (m.project) {
            const renamed = own.map((x) => (x === m.name ? to : x));
            writeList(project, m.kind, renamed);
            editProject(project, (text) => config.conditionedGroups(text, dimension(m.kind), m.name, to, 'rename'));
            project.lists[m.kind] = renamed;
            config.renameProject(project, dimension(m.kind), m.name, to);
          } else {
            config.renameSolution(model, m.kind, m.name, to);
            const active = m.kind === 'buildTypes' ? 'configuration' : 'platform';
            if (settings[active] === m.name) await startup.setSolutionSettings({ [active]: to });
          }
        }
        save(model);
      }
      return show();
    });
    panel.webview.onDidReceiveMessage((m) => request(m).catch((e) => error(e.message)));
    panel.webview.html = html();
    return panel;
  };

  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.configurationManager', open));
  // The page follows the status bar's choice and the solution's file changing on disk.
  context.subscriptions.push(startup.onDidChange(() => panel?.request({ type: 'ready' })));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,slnx}');
  watcher.onDidChange(() => panel?.request({ type: 'ready' }));
  context.subscriptions.push(watcher);

  function html() {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const texts = Object.fromEntries(Object.keys(T).filter((key) => typeof T[key] === 'string').map((key) => [key, T[key]]));
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 20px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .top { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
  .top label { display: flex; flex-direction: column; gap: 4px; }
  select, input[type=text] { font: inherit; padding: 3px 6px; min-width: 200px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--line)); }
  input[type=text] { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border-color: var(--vscode-input-border, var(--line)); }
  table { border-collapse: collapse; width: 100%; max-width: 980px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; color: var(--muted); }
  td select { min-width: 160px; width: 100%; }
  .check { width: 110px; text-align: center; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .caption { margin: 0 0 6px; color: var(--muted); }
  button { font: inherit; padding: 4px 14px; cursor: pointer; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .error { color: var(--vscode-errorForeground); margin: 8px 0; min-height: 1em; }
  .dialog { position: fixed; inset: 0; background: #0006; display: flex; align-items: center; justify-content: center; }
  .dialog[hidden] { display: none; }
  .box { min-width: 360px; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; color: var(--vscode-editorWidget-foreground, inherit); background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, var(--line)); box-shadow: 0 4px 16px #0008; }
  .box h2 { margin: 0 0 4px; font-size: 1.1em; font-weight: 600; }
  .box label { display: flex; flex-direction: column; gap: 4px; }
  .box label.inline { flex-direction: row; align-items: center; gap: 6px; }
  .buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  .names { display: flex; gap: 10px; }
  .names select { min-height: 140px; flex: 1; }
  .names .side { display: flex; flex-direction: column; gap: 6px; }
</style></head><body>
<div class="top">
  <label>${esc(T.activeConfiguration)} <select id="configuration"></select></label>
  <label>${esc(T.activePlatform)} <select id="platform"></select></label>
</div>
<p class="caption">${esc(T.contexts)}</p>
<table><thead><tr><th>${esc(T.project)}</th><th>${esc(T.configuration)}</th><th>${esc(T.platform)}</th>
  <th class="check"><label title="${esc(T.buildAll)}"><input type="checkbox" id="buildAll" aria-label="${esc(T.buildAll)}"> ${esc(T.build)}</label></th>
  <th class="check"><label title="${esc(T.deployAll)}"><input type="checkbox" id="deployAll" aria-label="${esc(T.deployAll)}"> ${esc(T.deploy)}</label></th></tr></thead>
<tbody id="rows"><tr><td colspan="5">${esc(T.loading)}</td></tr></tbody></table>
<div class="error" id="error"></div>
<div class="dialog" id="dialog" hidden><div class="box" id="box"></div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify(texts)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const shown = (p) => (p === 'AnyCPU' ? 'Any CPU' : p);
  const same = (a, b) => String(a).toLowerCase().split(' ').join('') === String(b).toLowerCase().split(' ').join('');
  const SOLUTION_PLATFORMS = ${JSON.stringify(SOLUTION_PLATFORMS)}, PROJECT_PLATFORMS = ${JSON.stringify(PROJECT_PLATFORMS)};
  let state;
  const send = (m) => { $('error').textContent = ''; vscode.postMessage(m); };
  const options = (list, current, label = (x) => x) => list.map((x) => '<option value="' + esc(x) + '"' + (same(x, current) ? ' selected' : '') + '>' + esc(label(x)) + '</option>').join('') +
    '<option value="*new">' + esc(T.newItem) + '</option><option value="*edit">' + esc(T.editItem) + '</option>';
  const render = () => {
    $('configuration').innerHTML = options(state.configurations, state.configuration);
    $('platform').innerHTML = options(state.platforms, state.platform);
    $('rows').innerHTML = state.projects.map((p, i) => '<tr><td>' + esc(p.name) + '</td>' +
      '<td><select data-i="' + i + '" data-kind="buildTypes">' + options(p.buildTypes.indexOf(p.buildType) < 0 ? [...p.buildTypes, p.buildType] : p.buildTypes, p.buildType) + '</select></td>' +
      '<td><select data-i="' + i + '" data-kind="platforms">' + options(p.platforms.some((x) => same(x, p.platform)) ? p.platforms : [...p.platforms, p.platform], p.platform, shown) + '</select></td>' +
      '<td class="check"><input type="checkbox" data-i="' + i + '" data-dim="build"' + (p.build ? ' checked' : '') + ' aria-label="' + esc(T.build + ' ' + p.name) + '"></td>' +
      '<td class="check"><input type="checkbox" data-i="' + i + '" data-dim="deploy"' + (p.deploy ? ' checked' : '') + ' aria-label="' + esc(T.deploy + ' ' + p.name) + '"></td></tr>').join('');
    for (const [id, dim] of [['buildAll', 'build'], ['deployAll', 'deploy']]) {
      const on = state.projects.filter((p) => p[dim]).length;
      $(id).checked = on > 0 && on === state.projects.length;
      $(id).indeterminate = on > 0 && on < state.projects.length;
    }
  };
  // The dialogs: a title, fields, and what OK sends.
  const field = {
    text: (id, label, value = '', list) => '<label>' + esc(label) + '<input type="text" id="' + id + '" value="' + esc(value) + '" spellcheck="false"' + (list ? ' list="' + id + 'List"' : '') + '>' +
      (list ? '<datalist id="' + id + 'List">' + list.map((x) => '<option value="' + esc(x) + '">').join('') + '</datalist>' : '') + '</label>',
    select: (id, label, list, label2 = (x) => x) => '<label>' + esc(label) + '<select id="' + id + '">' + list.map((x) => '<option value="' + esc(x) + '">' + esc(label2(x)) + '</option>').join('') + '</select></label>',
    check: (id, label) => '<label class="inline"><input type="checkbox" id="' + id + '" checked>' + esc(label) + '</label>',
  };
  const dialog = (title, body, ok) => {
    $('box').innerHTML = '<h2>' + esc(title) + '</h2>' + body + '<div class="buttons">' +
      (ok ? '<button id="ok">' + esc(T.ok) + '</button><button class="secondary" id="cancel">' + esc(T.cancel) + '</button>' : '<button class="secondary" id="cancel">' + esc(T.close) + '</button>') + '</div>';
    $('dialog').hidden = false;
    const first = $('box').querySelector('input[type=text],select');
    if (first) first.focus();
    if (ok) $('ok').onclick = () => { const m = ok(); if (m) { closeDialog(); send(m); } };
    $('cancel').onclick = closeDialog;
  };
  const closeDialog = () => { $('dialog').hidden = true; render(); };
  const newDialog = (kind, project) => {
    const empty = '*empty';
    if (!project) {
      const isConfig = kind === 'buildTypes';
      const from = isConfig ? state.configurations : state.platforms;
      dialog(isConfig ? T.newSolutionConfiguration : T.newSolutionPlatform,
        (isConfig ? field.text('name', T.name) : field.text('name', T.typePlatform, SOLUTION_PLATFORMS.find((x) => !state.platforms.some((y) => same(x, y))) || '', SOLUTION_PLATFORMS)) +
        field.select('from', T.copyFrom, [empty, ...from], (x) => (x === empty ? T.empty : x)) +
        field.check('create', isConfig ? T.createProjectConfigurations : T.createProjectPlatforms),
        () => ({ type: 'newSolution', kind, name: $('name').value.trim(), from: $('from').value === empty ? '' : $('from').value, create: $('create').checked }));
      $('from').value = isConfig ? state.configuration : state.platform;
      return;
    }
    const isConfig = kind === 'buildTypes';
    const own = isConfig ? project.buildTypes : project.platforms;
    dialog(isConfig ? T.newProjectConfiguration : T.newProjectPlatform,
      (isConfig ? field.text('name', T.name) : field.select('name', T.newPlatform, PROJECT_PLATFORMS.filter((x) => !own.some((y) => same(x, y))), shown)) +
      field.select('from', T.copyFrom, [empty, ...own], (x) => (x === empty ? T.empty : shown(x))) +
      field.check('create', isConfig ? T.createSolutionConfigurations : T.createSolutionPlatforms),
      () => ({ type: 'newProject', project: project.path, kind, name: $('name').value.trim(), from: $('from').value === empty ? '' : $('from').value, create: $('create').checked }));
    $('from').value = isConfig ? project.buildType : project.platform;
  };
  const editDialog = (kind, project) => {
    const isConfig = kind === 'buildTypes';
    const list = project ? (isConfig ? project.buildTypes : project.platforms) : (isConfig ? state.configurations : state.platforms);
    const title = project ? (isConfig ? T.editProjectConfigurations : T.editProjectPlatforms) : (isConfig ? T.editSolutionConfigurations : T.editSolutionPlatforms);
    dialog(title, '<label>' + esc(isConfig ? T.name : T.platforms) + '</label><div class="names"><select id="names" size="8">' +
      list.map((x, i) => '<option value="' + esc(x) + '"' + (i ? '' : ' selected') + '>' + esc(shown(x)) + '</option>').join('') +
      '</select><div class="side"><button class="secondary" id="remove">' + esc(T.remove) + '</button><button class="secondary" id="rename">' + esc(T.rename) + '</button></div></div>' +
      '<div id="renameRow" hidden>' + field.text('to', T.name) + '<div class="buttons"><button id="renameOk">' + esc(T.ok) + '</button></div></div>');
    const base = { type: 'edit', kind, project: project && project.path };
    $('remove').onclick = () => { closeDialog(); send({ ...base, op: 'remove', name: $('names').value }); };
    $('rename').onclick = () => { $('renameRow').hidden = false; $('to').value = shown($('names').value); $('to').focus(); $('to').select(); };
    $('renameOk').onclick = () => { const name = $('names').value, to = $('to').value.trim(); closeDialog(); send({ ...base, op: 'rename', name, to }); };
  };
  // A list's <Nowy...> / <Edytuj...> open their dialog (the list going back to what it was), anything else is chosen.
  const chosen = (select, kind, project, pick) => {
    if (select.value === '*new') return newDialog(kind, project);
    if (select.value === '*edit') return editDialog(kind, project);
    pick(select.value);
  };
  $('configuration').onchange = (e) => chosen(e.target, 'buildTypes', null, (v) => send({ type: 'active', kind: 'buildTypes', value: v }));
  $('platform').onchange = (e) => chosen(e.target, 'platforms', null, (v) => send({ type: 'active', kind: 'platforms', value: v }));
  $('rows').addEventListener('change', (e) => {
    const t = e.target, p = state.projects[+t.dataset.i];
    if (!p) return;
    if (t.dataset.dim) return send({ type: 'cell', project: p.path, change: { [t.dataset.dim]: t.checked } });
    chosen(t, t.dataset.kind, p, (v) => send({ type: 'cell', project: p.path, change: { [t.dataset.kind === 'buildTypes' ? 'buildType' : 'platform']: v } }));
  });
  $('buildAll').onchange = (e) => send({ type: 'all', dimension: 'build', value: e.target.checked });
  $('deployAll').onchange = (e) => send({ type: 'all', dimension: 'deploy', value: e.target.checked });
  document.addEventListener('keydown', (e) => {
    if ($('dialog').hidden) return;
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Enter' && $('ok') && e.target.tagName !== 'BUTTON') $('ok').click();
  });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'show') { state = m; if ($('dialog').hidden) render(); }
    if (m.type === 'error') $('error').textContent = m.text;
  });
  send({ type: 'ready' });
</script></body></html>`;
  }

  return { open, get panel() { return panel; } };
}

module.exports = { registerConfigurationManager };
