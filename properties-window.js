// Visual Studio 2026's Properties window (F4) under the Solution Explorer: what is selected there (a file, a folder, a
// project) with its rule's properties (item-properties.js), Według kategorii or Alfabetycznie, the selected property's
// name and description at the bottom; Akcja kompilacji and the file's metadata written to the project file as VS writes
// them, then read back from MSBuild.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { table, language } = require('./l10n');
const ip = require('./item-properties');
const { writeFileWhenFree } = require('./write-file');

// VS's own words for these (its Properties window), in English and Polish (l10n/pl.json).
const T = table({
  categorized: 'Categorized',
  alphabetical: 'Alphabetical',
  nothing: 'Select a file, folder or project in the Solution Explorer.',
  loading: 'Reading the project…',
  saveFailed: 'Could not save {0}: {1}',
});

const PROJECT = /\.(cs|vb|fs)proj$/i;

/** The project a file or folder is in: the nearest folder above it with a project file. */
function projectOf(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const found = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => PROJECT.test(f));
    if (found) return path.join(dir, found);
    if (path.dirname(dir) === dir) return undefined;
  }
}

function registerPropertiesWindow(context, solutionView) {
  const loaded = ip.loadRules(context.asAbsolutePath('rules'), language());
  const types = [...new Set([...loaded.itemTypes.map((t) => t.value), 'AdditionalFiles', 'EditorConfigFiles', 'AvailableItemName'])];
  const cache = new Map(); // project -> { mtime, items }
  let webview;
  let target; // { kind: 'file' | 'folder' | 'project', file, project }
  const state = { target: undefined, sheet: undefined }; // what the window shows (the tests read it)

  /** The project's items, by type, from one MSBuild evaluation (kept while the project file is unchanged). */
  const itemsOf = (project) => {
    const mtime = fs.statSync(project).mtimeMs;
    const cached = cache.get(project);
    if (cached?.mtime === mtime) return cached.items;
    const items = new Promise((resolve) => execFile('dotnet', ['msbuild', project, ...types.map((t) => `-getItem:${t}`)],
      { cwd: path.dirname(project), windowsHide: true, maxBuffer: 64 << 20 }, (error, stdout) => {
        try { resolve(JSON.parse(stdout).Items || {}); } catch { resolve({}); }
      }));
    cache.set(project, { mtime, items });
    return items;
  };

  const show = async () => {
    if (!target) {
      state.sheet = undefined;
      webview?.postMessage({ type: 'empty' });
      return;
    }
    const shown = target;
    webview?.postMessage({ type: 'loading', name: path.basename(shown.file) });
    const items = shown.kind === 'file' && shown.project ? await itemsOf(shown.project) : {};
    if (shown !== target) return; // the selection moved on
    state.target = shown;
    state.sheet = ip.rowsFor(loaded, shown, items);
    webview?.postMessage({ type: 'show', name: path.basename(shown.file), sheet: state.sheet });
  };

  /** Follows the Solution Explorer: a project, a folder or a file (the solution and its folders show nothing). */
  const select = (item) => {
    const file = item?.contextValue?.startsWith('project') ? item.file : item?.resourceUri?.fsPath;
    const kind = item?.contextValue?.startsWith('project') ? 'project' : item?.contextValue === 'folder' ? 'folder' : item?.contextValue === 'file' ? 'file' : undefined;
    target = kind && file ? { kind, file, project: kind === 'project' ? file : projectOf(file) } : undefined;
    return show();
  };
  context.subscriptions.push(solutionView.view.onDidChangeSelection((e) => select(e.selection[0])));

  const set = async (name, value) => {
    if (!state.target || state.target.kind !== 'file' || !state.sheet?.itemType) return;
    const { project, file } = state.target;
    const text = fs.readFileSync(project, 'utf8');
    const row = state.sheet.rows.find((r) => r.name === name);
    if (!row || row.readOnly) return;
    const persisted = loaded.rules[state.sheet.itemType]?.properties.find((p) => p.name === name)?.persistedName || name;
    const next = name === '{}{ItemType}' ? ip.setItemType(text, project, file, state.sheet.itemType, value)
      : ip.setMetadata(text, project, file, state.sheet.itemType, persisted, value);
    if (next !== text) {
      try {
        writeFileWhenFree(project, next);
      } catch (e) {
        vscode.window.showErrorMessage(T.saveFailed(path.basename(project), e.message));
      }
    }
    await show();
  };

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('csharpShooter.propertiesWindow', {
    resolveWebviewView(webviewView) {
      webview = webviewView.webview;
      webview.options = { enableScripts: true };
      webview.html = html();
      webview.onDidReceiveMessage((m) => {
        if (m.type === 'ready') show();
        if (m.type === 'set') set(m.name, m.value).catch((e) => vscode.window.showErrorMessage(e.message));
      });
      webviewView.onDidDispose(() => (webview = undefined));
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  // F4, as VS's: the window, on what the Solution Explorer has selected.
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.propertiesWindow.show', async () => {
    await vscode.commands.executeCommand('csharpShooter.propertiesWindow.focus');
    await select(solutionView.view.selection[0]);
  }));

  function html() {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const texts = { categorized: T.categorized, alphabetical: T.alphabetical, nothing: T.nothing, loading: T.loading };
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  .bar { display: flex; gap: 2px; padding: 3px 6px; }
  .bar button { width: 24px; height: 22px; padding: 0; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--vscode-icon-foreground); background: transparent; border: 1px solid transparent; border-radius: 3px; }
  .bar button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .bar button.on { border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-activeBackground, transparent); }
  .grid { flex: 1; min-height: 0; overflow: auto; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  td { padding: 1px 6px; height: 20px; border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td.name { width: 48%; padding-left: 16px; border-right: 1px solid var(--line); }
  tr.cat td { padding-left: 4px; font-weight: 600; cursor: pointer; background: var(--vscode-sideBarSectionHeader-background, transparent); }
  tr.sel td.name { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  td.value { padding: 0 2px; }
  td.value select, td.value input { width: 100%; font: inherit; padding: 1px 4px; border: 1px solid transparent; color: var(--vscode-foreground); background: transparent; }
  td.value select:focus, td.value input:focus { outline: none; border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
  td.value select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  td.value .ro { padding: 1px 5px; color: var(--muted); user-select: text; }
  .desc { height: 76px; max-height: 35%; flex-shrink: 0; padding: 6px 8px; border-top: 1px solid var(--line); overflow: auto; }
  .desc b { display: block; margin-bottom: 2px; }
  .message { padding: 8px 10px; color: var(--muted); }
</style></head><body>
<div class="bar">
  <button id="categorized" title="${esc(T.categorized)}" aria-label="${esc(T.categorized)}"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h4v4H1zM7 3h8v1H7zM7 5h6v1H7zM1 9h4v4H1zM7 10h8v1H7zM7 12h6v1H7z"/></svg></button>
  <button id="alphabetical" title="${esc(T.alphabetical)}" aria-label="${esc(T.alphabetical)}"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><text x="0" y="7" font-size="7" font-family="Segoe UI, sans-serif" font-weight="700">A</text><text x="0" y="15" font-size="7" font-family="Segoe UI, sans-serif" font-weight="700">Z</text><path d="M11 1h1v11l2-2 .7.7L11.5 14 8.3 10.7 9 10l2 2z"/></svg></button>
</div>
<div class="grid" id="grid"><div class="message">${esc(T.nothing)}</div></div>
<div class="desc" id="desc"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify(texts)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const saved = vscode.getState() || {};
  let mode = saved.mode || 'categorized', sheet, selected = saved.selected, closed = new Set();
  const keep = () => vscode.setState({ mode, selected });
  const editor = (r) => {
    if (r.readOnly) return '<div class="ro" title="' + esc(r.value) + '">' + esc(r.value) + '</div>';
    if (r.choices) return '<select data-name="' + esc(r.name) + '">' + r.choices.map((c) => '<option value="' + esc(c.value) + '"' +
      (String(c.value).toLowerCase() === String(r.value).toLowerCase() ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</select>';
    return '<input type="text" data-name="' + esc(r.name) + '" value="' + esc(r.value) + '" spellcheck="false">';
  };
  const row = (r) => '<tr data-row="' + esc(r.name) + '"' + (r.name === selected ? ' class="sel"' : '') + '><td class="name" title="' + esc(r.title) + '">' + esc(r.title) + '</td><td class="value">' + editor(r) + '</td></tr>';
  const describe = () => {
    const r = sheet && sheet.rows.find((x) => x.name === selected);
    $('desc').innerHTML = r ? '<b>' + esc(r.title) + '</b>' + esc(r.description) : '';
  };
  const render = () => {
    $('categorized').classList.toggle('on', mode === 'categorized');
    $('alphabetical').classList.toggle('on', mode === 'alphabetical');
    if (!sheet) return;
    const byTitle = (a, b) => a.title.localeCompare(b.title);
    let html = '';
    if (mode === 'alphabetical') html = sheet.rows.slice().sort(byTitle).map(row).join('');
    else for (const c of sheet.categories) {
      const rows = sheet.rows.filter((r) => r.category === c.name);
      if (!rows.length) continue;
      html += '<tr class="cat" data-cat="' + esc(c.name) + '"><td colspan="2">' + (closed.has(c.name) ? '▸ ' : '▾ ') + esc(c.title) + '</td></tr>';
      if (!closed.has(c.name)) html += rows.slice().sort(byTitle).map(row).join('');
    }
    $('grid').innerHTML = '<table>' + html + '</table>';
    describe();
  };
  $('categorized').onclick = () => { mode = 'categorized'; keep(); render(); };
  $('alphabetical').onclick = () => { mode = 'alphabetical'; keep(); render(); };
  $('grid').addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) { closed.has(cat.dataset.cat) ? closed.delete(cat.dataset.cat) : closed.add(cat.dataset.cat); return render(); }
    const tr = e.target.closest('[data-row]');
    if (tr && tr.dataset.row !== selected) {
      selected = tr.dataset.row;
      keep();
      document.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
      tr.classList.add('sel');
      describe();
    }
  });
  $('grid').addEventListener('focusin', (e) => { const tr = e.target.closest('[data-row]'); if (tr) tr.click(); });
  $('grid').addEventListener('change', (e) => {
    if (e.target.dataset.name) vscode.postMessage({ type: 'set', name: e.target.dataset.name, value: e.target.value });
  });
  $('grid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
    if (e.key === 'Escape' && e.target.tagName === 'INPUT') { const r = sheet.rows.find((x) => x.name === e.target.dataset.name); e.target.value = r ? r.value : ''; e.target.blur(); }
  });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'empty') { sheet = undefined; $('grid').innerHTML = '<div class="message">' + esc(T.nothing) + '</div>'; $('desc').innerHTML = ''; }
    if (m.type === 'loading' && !sheet) $('grid').innerHTML = '<div class="message">' + esc(T.loading) + '</div>';
    if (m.type === 'show') {
      sheet = m.sheet;
      if (!sheet.rows.some((r) => r.name === selected)) selected = (sheet.rows.find((r) => !r.readOnly) || sheet.rows[0] || {}).name;
      render();
    }
  });
  render();
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  return { state, select, show, set };
}

module.exports = { registerPropertiesWindow, projectOf };
