// Visual Studio 2026's Publish page for a project, in an editor tab: its folder profiles to pick, New profile, Publish, More
// actions (rename, delete), the profile's settings as VS's settings dialog has them (configuration, target framework,
// deployment mode, target runtime, target location, file publish options), saved to its .pubxml, and how the last publish
// ended. Publishing itself is csharpShooter.solution.publish; this is its page.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { readProject } = require('./solution');

const T = {
  title: 'Opublikuj', newProfile: 'Nowy profil', publish: 'Opublikuj', moreActions: 'Więcej akcji', rename: 'Zmień nazwę', delete: 'Usuń',
  renameProfile: 'Zmień nazwę profilu', deleteConfirm: 'Usuń profil publikowania', ready: 'Gotowy do opublikowania.',
  publishing: (where) => `Trwa publikowanie folderu ${where}...`, succeeded: 'Publikowanie zakończyło się powodzeniem.',
  failed: 'Publikowanie zakończyło się niepowodzeniem.', openFolder: 'Otwórz folder',
  settings: 'Ustawienia profilu', configuration: 'Konfiguracja', framework: 'Struktura docelowa', mode: 'Tryb wdrożenia',
  dependent: 'Zależny od struktury', selfContained: 'Samodzielny', runtime: 'Docelowe środowisko uruchomieniowe', portable: 'Przenośne',
  location: 'Lokalizacja docelowa', browse: 'Przeglądaj...', options: 'Opcje publikowania plików', deleteExisting: 'Usuń istniejące pliki',
  singleFile: 'Utwórz pojedynczy plik', readyToRun: 'Włącz kompilację ReadyToRun', trim: 'Przytnij nieużywany kod', save: 'Zapisz',
  noProfiles: 'Ten projekt nie ma jeszcze profilu publikowania: utwórz go przyciskiem Nowy profil.', saved: 'Zapisano.',
};
const RUNTIMES = ['win-x64', 'win-x86', 'win-arm64', 'linux-x64', 'linux-arm64', 'linux-musl-x64', 'osx-x64', 'osx-arm64'];

const dirOf = (projectFile) => path.join(path.dirname(projectFile), 'Properties', 'PublishProfiles');
const profilesOf = (projectFile) => (fs.existsSync(dirOf(projectFile)) ? fs.readdirSync(dirOf(projectFile)).filter((f) => f.endsWith('.pubxml')).map((f) => path.basename(f, '.pubxml')).sort() : []);
const fileOf = (projectFile, profile) => path.join(dirOf(projectFile), `${profile}.pubxml`);
const unxml = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const xml = (s) => String(s).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A profile's settings, as its .pubxml sets them (MSBuild's own defaults where it does not). */
function readProfile(projectFile, profile) {
  const text = fs.readFileSync(fileOf(projectFile, profile), 'utf8');
  const get = (tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text); return m ? unxml(m[1]) : undefined; };
  return {
    configuration: get('LastUsedBuildConfiguration') || 'Release',
    framework: get('TargetFramework') || readProject(projectFile).frameworks[0] || '',
    selfContained: get('SelfContained') === 'true',
    runtime: get('RuntimeIdentifier') || '',
    location: get('PublishUrl') || get('PublishDir') || '',
    deleteExisting: get('DeleteExistingFiles') === 'true',
    singleFile: get('PublishSingleFile') === 'true',
    readyToRun: get('PublishReadyToRun') === 'true',
    trim: get('PublishTrimmed') === 'true',
    method: get('WebPublishMethod') || get('PublishProvider') || 'FileSystem',
  };
}

/** Writes settings into a .pubxml as VS does: each element replaced where it is, added at the end of its PropertyGroup
 *  where it is not, left out (removed) where it has no value; the rest of the file as it was. */
function writeProfile(projectFile, profile, s) {
  const file = fileOf(projectFile, profile);
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const set = (tag, value) => {
    const re = new RegExp(`[ \\t]*<${tag}>[^<]*</${tag}>\\r?\\n?|[ \\t]*<${tag}\\s*/>\\r?\\n?`);
    if (value === undefined || value === '' || value === false) {
      text = text.replace(re, '');
    } else if (re.test(text)) {
      text = text.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}\\s*/>`), `<${tag}>${xml(value)}</${tag}>`);
    } else {
      text = text.replace(/([ \t]*)<\/PropertyGroup>/, (all, indent) => `${indent}  <${tag}>${xml(value)}</${tag}>${eol}${all}`);
    }
  };
  set('LastUsedBuildConfiguration', s.configuration);
  set('TargetFramework', s.framework);
  set('SelfContained', s.runtime ? String(s.selfContained) : undefined);
  set('RuntimeIdentifier', s.runtime);
  set('PublishUrl', s.location);
  set('PublishDir', s.location);
  set('DeleteExistingFiles', String(!!s.deleteExisting));
  // Single file, ReadyToRun and trimming need a runtime, as VS greys them for a portable app.
  set('PublishSingleFile', s.runtime && s.singleFile ? 'true' : undefined);
  set('PublishReadyToRun', s.runtime && s.readyToRun ? 'true' : undefined);
  set('PublishTrimmed', s.runtime && s.selfContained && s.trim ? 'true' : undefined);
  fs.writeFileSync(file, text);
}

function registerPublishPage(context, newPublishProfile) {
  const pages = new Map(); // project file -> panel
  const state = { last: undefined }; // for the tests

  const open = (item) => {
    const projectFile = item.file;
    const existing = pages.get(projectFile);
    if (existing) {
      existing.reveal();
      return existing;
    }
    const name = path.basename(projectFile, path.extname(projectFile));
    const panel = vscode.window.createWebviewPanel('csharpShooter.publish', `${T.title}: ${name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = new vscode.ThemeIcon('cloud-upload');
    pages.set(projectFile, panel);
    panel.onDidDispose(() => pages.delete(projectFile));
    const post = (m) => panel.webview.postMessage(m);
    const frameworks = readProject(projectFile).frameworks;
    let selected = profilesOf(projectFile)[0];
    const show = (status) => {
      const profiles = profilesOf(projectFile);
      if (!profiles.includes(selected)) selected = profiles[0];
      post({ type: 'show', profiles, selected, settings: selected ? readProfile(projectFile, selected) : null, frameworks, runtimes: RUNTIMES, status });
    };
    const request = (panel.request = async (m) => {
      if (m.type === 'ready') show({ text: T.ready });
      if (m.type === 'select') {
        selected = m.profile;
        show({ text: T.ready });
      }
      if (m.type === 'new') {
        const made = await newPublishProfile(projectFile, dirOf(projectFile), profilesOf(projectFile), m.folder);
        if (made) selected = made;
        show({ text: T.ready });
      }
      if (m.type === 'save' && selected) {
        writeProfile(projectFile, selected, m.settings);
        show({ text: T.saved });
      }
      if (m.type === 'browse') {
        const [folder] = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: T.location })) || [];
        if (folder) post({ type: 'location', value: folder.fsPath });
      }
      if (m.type === 'rename' && selected) {
        const to = m.to ?? (await vscode.window.showInputBox({ title: T.renameProfile, value: selected, validateInput: (v) => (/^[\w .-]+$/.test(v) ? undefined : '…') }));
        if (to && to !== selected && !profilesOf(projectFile).includes(to)) {
          fs.renameSync(fileOf(projectFile, selected), fileOf(projectFile, to));
          if (fs.existsSync(`${fileOf(projectFile, selected)}.user`)) fs.renameSync(`${fileOf(projectFile, selected)}.user`, `${fileOf(projectFile, to)}.user`);
          selected = to;
        }
        show({ text: T.ready });
      }
      if (m.type === 'delete' && selected) {
        const sure = m.confirmed || (await vscode.window.showWarningMessage(`${T.deleteConfirm}: ${selected}?`, { modal: true }, T.delete)) === T.delete;
        if (sure) {
          fs.rmSync(fileOf(projectFile, selected), { force: true });
          fs.rmSync(`${fileOf(projectFile, selected)}.user`, { force: true });
        }
        show({ text: T.ready });
      }
      if (m.type === 'publish' && selected) {
        const where = readProfile(projectFile, selected).location;
        show({ text: T.publishing(where), busy: true });
        const r = await vscode.commands.executeCommand('csharpShooter.solution.publish', item, selected);
        state.last = r;
        show(r?.code === 0 ? { text: `${T.succeeded} ${new Date().toLocaleString('pl-PL')}`, ok: true, folder: r.folder } : { text: T.failed, error: true });
      }
      if (m.type === 'openFolder' && m.folder) await vscode.env.openExternal(vscode.Uri.file(m.folder));
    });
    panel.webview.onDidReceiveMessage(request);
    panel.webview.html = html();
    return panel;
  };

  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.solution.publishPage', open));

  function html() {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 28px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 860px; }
  h1 { font-size: 1.6em; font-weight: 600; margin: 0 0 16px; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  select, input[type=text] { font: inherit; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); min-width: 220px; }
  button { font: inherit; padding: 4px 14px; border: 1px solid transparent; cursor: pointer; border-radius: 3px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .menu { position: relative; }
  .menu ul { display: none; position: absolute; top: 100%; left: 0; margin: 2px 0 0; padding: 4px 0; list-style: none; min-width: 160px; z-index: 2;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--line)); box-shadow: 0 2px 8px #0005; }
  .menu.open ul { display: block; }
  .menu li { padding: 4px 14px; cursor: pointer; }
  .menu li:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground); }
  .status { margin: 14px 0; padding: 10px 12px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); }
  .status.ok { border-color: var(--vscode-testing-iconPassed, #3fb950); }
  .status.error { border-color: var(--vscode-errorForeground); }
  .status a { color: var(--vscode-textLink-foreground); cursor: pointer; margin-left: 8px; }
  h2 { font-size: 1.15em; font-weight: 600; margin: 22px 0 10px; }
  .grid { display: grid; grid-template-columns: 240px 1fr; gap: 10px 16px; align-items: center; }
  .grid label { color: var(--muted); }
  .row { display: flex; gap: 8px; }
  .row input { flex: 1; }
  .checks { display: flex; flex-direction: column; gap: 6px; }
  .checks label { color: var(--vscode-foreground); display: flex; gap: 8px; align-items: center; }
  .checks label.off { opacity: .5; }
  .actions { margin-top: 18px; display: flex; gap: 8px; }
  .empty { color: var(--muted); margin: 16px 0; }
</style></head><body>
<h1>${esc(T.title)}</h1>
<div class="bar">
  <select id="profile" aria-label="Profil"></select>
  <button id="new">${esc(T.newProfile)}</button>
  <button id="publish" class="primary">${esc(T.publish)}</button>
  <div class="menu" id="more"><button id="moreBtn">${esc(T.moreActions)} ▾</button><ul>
    <li data-act="rename">${esc(T.rename)}</li><li data-act="delete">${esc(T.delete)}</li></ul></div>
</div>
<div class="status" id="status"></div>
<div id="body">
  <h2>${esc(T.settings)}</h2>
  <div class="grid">
    <label for="configuration">${esc(T.configuration)}</label><select id="configuration"><option>Release</option><option>Debug</option></select>
    <label for="framework">${esc(T.framework)}</label><select id="framework"></select>
    <label for="mode">${esc(T.mode)}</label><select id="mode"><option value="dependent">${esc(T.dependent)}</option><option value="self">${esc(T.selfContained)}</option></select>
    <label for="runtime">${esc(T.runtime)}</label><select id="runtime"></select>
    <label for="location">${esc(T.location)}</label><div class="row"><input type="text" id="location" spellcheck="false"><button id="browse">${esc(T.browse)}</button></div>
    <label>${esc(T.options)}</label>
    <div class="checks">
      <label><input type="checkbox" id="deleteExisting"> ${esc(T.deleteExisting)}</label>
      <label id="singleFileBox"><input type="checkbox" id="singleFile"> ${esc(T.singleFile)}</label>
      <label id="readyToRunBox"><input type="checkbox" id="readyToRun"> ${esc(T.readyToRun)}</label>
      <label id="trimBox"><input type="checkbox" id="trim"> ${esc(T.trim)}</label>
    </div>
  </div>
  <div class="actions"><button id="save" class="primary">${esc(T.save)}</button></div>
</div>
<div class="empty" id="empty" hidden>${esc(T.noProfiles)}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const portable = ${JSON.stringify(T.portable)};
  let folder;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const options = (el, list, value) => { el.innerHTML = list.map((v) => '<option value="' + esc(v.value ?? v) + '">' + esc(v.label ?? v) + '</option>').join(''); el.value = value; };
  // As VS greys them: single file and ReadyToRun need a runtime, trimming a self-contained one.
  const greys = () => {
    const rt = $('runtime').value, self = $('mode').value === 'self';
    for (const [id, on] of [['singleFile', !!rt], ['readyToRun', !!rt], ['trim', !!rt && self]]) { $(id).disabled = !on; $(id + 'Box').classList.toggle('off', !on); }
    $('mode').disabled = !rt;
    if (!rt) $('mode').value = 'dependent';
  };
  $('runtime').onchange = greys; $('mode').onchange = greys;
  $('profile').onchange = () => vscode.postMessage({ type: 'select', profile: $('profile').value });
  $('new').onclick = () => vscode.postMessage({ type: 'new' });
  $('publish').onclick = () => vscode.postMessage({ type: 'publish' });
  $('browse').onclick = () => vscode.postMessage({ type: 'browse' });
  $('moreBtn').onclick = (e) => { e.stopPropagation(); $('more').classList.toggle('open'); };
  document.addEventListener('click', () => $('more').classList.remove('open'));
  document.querySelectorAll('#more li').forEach((li) => li.onclick = () => vscode.postMessage({ type: li.dataset.act }));
  $('save').onclick = () => vscode.postMessage({ type: 'save', settings: {
    configuration: $('configuration').value, framework: $('framework').value, selfContained: $('mode').value === 'self', runtime: $('runtime').value,
    location: $('location').value, deleteExisting: $('deleteExisting').checked, singleFile: $('singleFile').checked, readyToRun: $('readyToRun').checked, trim: $('trim').checked } });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'location') $('location').value = m.value;
    if (m.type !== 'show') return;
    options($('profile'), m.profiles, m.selected);
    const has = !!m.settings;
    $('body').hidden = !has; $('empty').hidden = has; $('publish').disabled = !has || !!m.status.busy; $('moreBtn').disabled = !has;
    const st = $('status');
    st.className = 'status' + (m.status.ok ? ' ok' : m.status.error ? ' error' : '');
    folder = m.status.folder;
    st.innerHTML = esc(m.status.text) + (folder ? ' <a id="open">' + esc(${JSON.stringify(T.openFolder)}) + '</a>' : '');
    if (folder) $('open').onclick = () => vscode.postMessage({ type: 'openFolder', folder });
    if (!has) return;
    const s = m.settings;
    $('configuration').value = s.configuration;
    options($('framework'), [...new Set([s.framework, ...m.frameworks].filter(Boolean))], s.framework);
    options($('runtime'), [{ value: '', label: portable }, ...[...new Set([s.runtime, ...m.runtimes].filter(Boolean))]], s.runtime);
    $('mode').value = s.selfContained ? 'self' : 'dependent';
    $('location').value = s.location;
    for (const k of ['deleteExisting', 'singleFile', 'readyToRun', 'trim']) $(k).checked = s[k];
    greys();
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  return { open, pages, state, readProfile, writeProfile };
}

module.exports = { registerPublishPage, readProfile, writeProfile };
