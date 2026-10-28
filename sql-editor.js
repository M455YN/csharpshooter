// The SQL editor of .sql files, as vsc-ms-sql-manager's (jakubkozera, MIT) and SSMS's query window: a toolbar (Execute,
// Cancel, Parse, the connection with Change Connection and Disconnect, the database as a drop-down, the query's state),
// the T-SQL in Monaco (shipped in media/monaco, scripts/fetch-monaco.js) and the results below it in the same page
// (Results, Messages, VS's status line). It is a custom text editor: the .sql stays a text document, which the SQL Tools
// Service sees as any other, so the page's IntelliSense, hovers and underlined errors are the service's, asked through
// VS Code for that document. Reopen With > Text Editor gives VS Code's own editor with the toolbar row above line 1.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { table, tn } = require('./l10n');

const VIEW_TYPE = 'csharpShooter.sqlEditor';
const MAX_ITEMS = 3000; // completion items one request gives the page

const T = table({
  execute: 'Execute',
  cancel: 'Cancel',
  parse: 'Parse',
  connect: 'Connect',
  disconnect: 'Disconnect',
  changeConnection: 'Change Connection...',
  notConnected: 'not connected',
  availableDatabases: 'Available Databases',
  results: 'Results',
  messages: 'Messages',
  connecting: 'Connecting...',
  preparing: 'Preparing IntelliSense...',
  executing: 'Executing query...',
  succeeded: 'Query executed successfully.',
  failed: 'Query completed with errors.',
  canceled: 'Query canceled.',
  connected: 'Connected.',
  newConnection: 'New Connection Opened',
  completionTime: 'Completion time: {0}',
  truncated: 'The first {0} of {1} rows are shown.',
});

// VS Code's CompletionItemKind -> Monaco's
const KINDS = { 0: 18, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 7, 8: 8, 9: 9, 10: 12, 11: 13, 12: 15, 13: 17, 14: 27, 15: 19, 16: 20,
  17: 21, 18: 23, 19: 16, 20: 14, 21: 6, 22: 10, 23: 11, 24: 24 };

/** host: the SQL module's { state(doc), execute(doc, text, firstLine), parse(doc, text, firstLine), cancel(doc),
 *  connect(doc), disconnect(doc), databases(doc), useDatabase(doc, name) }. */
function registerSqlEditor(context, host) {
  const pages = new Map(); // document uri -> { panel, doc, post, sink }
  const monacoRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'monaco');

  function stateOf(doc) {
    const s = host.state(doc);
    const run = s?.run;
    // a large database's names take the service a while: until then it completes keywords only
    const status = !s ? '' : s.state === 'connecting' ? T.connecting : s.running ? T.executing : s.state === 'preparing' ? T.preparing
      : run?.status === 'cancelled' ? T.canceled : run ? (run.hasError ? T.failed : T.succeeded) : s.state === 'connected' ? T.newConnection : T.connected;
    return s && {
      connected: true, running: !!s.running, status, error: !!run?.hasError,
      server: s.version ? `${s.summary.server} (${s.version})` : s.summary.server, user: s.spid ? `${s.summary.user} (${s.spid})` : s.summary.user,
      database: s.summary.database, elapsed: run?.elapsed || '00:00:00', rows: tn(run?.rowCount || 0, '{0} row', '{0} rows'),
    };
  }

  const provider = {
    resolveCustomTextEditor(doc, panel) {
      // posted: what the page was sent, for the tests
      const page = { panel, doc, posted: [], errors: [], post: (m) => (page.posted.push(m), panel.webview.postMessage(m)) };
      pages.set(doc.uri.toString(), page);
      panel.webview.options = { enableScripts: true, localResourceRoots: [monacoRoot] };
      panel.webview.html = html(panel.webview, monacoRoot);
      let applying = false; // the page's own edit coming back as a document change
      page.update = () => page.post({ type: 'state', state: stateOf(doc) });
      const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== doc.uri.toString() || applying || !e.contentChanges.length) return;
        page.post({ type: 'text', text: doc.getText() });
      });
      const diag = vscode.languages.onDidChangeDiagnostics((e) => {
        if (e.uris.some((u) => u.toString() === doc.uri.toString())) sendMarkers();
      });
      function sendMarkers() {
        page.post({ type: 'markers', markers: vscode.languages.getDiagnostics(doc.uri).map((d) => ({
          severity: d.severity === vscode.DiagnosticSeverity.Error ? 8 : d.severity === vscode.DiagnosticSeverity.Warning ? 4 : 2,
          message: d.message, startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
        })) });
      }
      page.receive = async (m) => {
        const reply = (value) => page.post({ type: 'reply', id: m.id, value });
        try {
          if (m.type === 'ready') {
            page.post({ type: 'init', text: doc.getText(), texts: Object.fromEntries(Object.keys(T).map((k) => [k, T[k]])) });
            page.update();
            sendMarkers();
            if (page.sink?.run) page.post({ type: 'run', run: page.sink.run });
          }
          if (m.type === 'edit') {
            // the page's text, as one edit of the whole document (Monaco has the undo history)
            if (m.text === doc.getText()) return;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), m.text);
            applying = true;
            await vscode.workspace.applyEdit(edit).finally(() => (applying = false));
          }
          if (m.type === 'save') await doc.save();
          if (m.type === 'monacoReady') page.monacoReady = true;
          if (m.type === 'suggestShown') page.suggestShown = m.labels;
          if (m.type === 'pageError') page.errors.push(m.message);
          if (m.type === 'execute') await host.execute(doc, m.text, m.firstLine);
          if (m.type === 'parse') await host.parse(doc, m.text, m.firstLine);
          if (m.type === 'cancel') await host.cancel(doc);
          if (m.type === 'connect') await host.connect(doc);
          if (m.type === 'disconnect') await host.disconnect(doc);
          if (m.type === 'databases') reply(await host.databases(doc));
          if (m.type === 'useDatabase') await host.useDatabase(doc, m.name);
          if (m.type === 'complete') {
            // A large database gives thousands of items, its keywords first: the page gets those matching the word typed,
            // the database's objects (tables, views, functions, columns) before the keywords, and asks again as it grows.
            const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(m.line, m.character));
            const line = doc.lineAt(Math.min(m.line, doc.lineCount - 1)).text.slice(0, m.character);
            const word = (/[\w@#$]*$/.exec(line)?.[0] || '').toLowerCase();
            const labelOf = (i) => (typeof i.label === 'string' ? i.label : i.label.label);
            const all = (list?.items || []).filter((i) => !word || (i.filterText || labelOf(i)).toLowerCase().replace(/^[\[\]"]+/, '').startsWith(word)
              || labelOf(i).toLowerCase().includes(word));
            const keyword = (i) => (i.kind === vscode.CompletionItemKind.Keyword ? 1 : 0);
            all.sort((a, b) => keyword(a) - keyword(b));
            const items = all.slice(0, MAX_ITEMS);
            reply({ incomplete: items.length < (list?.items || []).length, items: items.map((i) => ({
              label: labelOf(i), kind: KINDS[i.kind] ?? 18, detail: i.detail,
              documentation: typeof i.documentation === 'string' ? i.documentation : i.documentation?.value,
              insertText: typeof i.insertText === 'string' ? i.insertText : i.insertText?.value ?? labelOf(i),
              snippet: i.insertText instanceof vscode.SnippetString, sortText: `${keyword(i)}${i.sortText || labelOf(i)}`, filterText: i.filterText,
            })) });
          }
          if (m.type === 'hover') {
            const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(m.line, m.character));
            reply((hovers || []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))));
          }
        } catch (e) {
          if (m.id !== undefined) reply(null);
          page.post({ type: 'error', message: String(e?.message || e) });
        }
      };
      panel.webview.onDidReceiveMessage(page.receive);
      panel.onDidChangeViewState(() => panel.active && host.activated?.(doc));
      panel.onDidDispose(() => {
        sub.dispose();
        diag.dispose();
        pages.delete(doc.uri.toString());
      });
    },
  };
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true } }));

  return {
    VIEW_TYPE,
    has: (doc) => pages.has(doc.uri.toString()),
    /** The document of the SQL editor page in front, if one is. */
    active: () => [...pages.values()].find((p) => p.panel.active)?.doc,
    reveal: (doc) => pages.get(doc.uri.toString())?.panel.reveal(),
    update: (doc) => (doc ? pages.get(doc.uri.toString())?.update() : pages.forEach((p) => p.update())),
    /** A run's results for the page of a document (the bottom panel's otherwise), with the Results panel's handlers. */
    sink(doc) {
      const page = pages.get(doc.uri.toString());
      if (!page) return undefined;
      return {
        start() {
          const run = { status: 'running', sets: [], messages: [], rowCount: 0, hasError: false, started: Date.now() };
          page.sink = { run };
          const send = () => page.post({ type: 'run', run });
          send();
          return {
            run,
            resultSet(set) { run.sets.push(set); run.rowCount += set.rowCount; if (set.truncated) run.messages.push({ text: T.truncated(set.rows.length, set.rowCount) }); send(); },
            message(text, isError, line) { run.messages.push({ text, isError, line }); run.hasError ||= isError; send(); },
            finish(status, elapsed) { run.status = status; run.elapsed = elapsed; run.messages.push({ text: T.completionTime(new Date().toISOString()) }); send(); },
          };
        },
        run: () => page.sink?.run,
      };
    },
    /** For the tests: a page's messages to it. */
    page: (doc) => pages.get(doc.uri.toString()),
  };
}

function html(webview, monacoRoot) {
  const nonce = String(Math.random()).slice(2);
  const vs = webview.asWebviewUri(vscode.Uri.joinPath(monacoRoot, 'vs')).toString();
  const worker = fs.readdirSync(path.join(monacoRoot.fsPath, 'vs', 'assets')).find((f) => /^editor\.worker/.test(f));
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; `
    + `script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src blob:;`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${vs}/editor/editor.main.css">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .bar { display: flex; align-items: center; gap: 4px; padding: 5px 8px; border-bottom: 1px solid var(--line); flex: none; }
  .bar button { font: inherit; display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid transparent; border-radius: 3px; cursor: pointer; color: var(--vscode-foreground); background: none; }
  .bar button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .bar button:disabled { opacity: .45; cursor: default; }
  .bar button.run { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .bar button.run:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .bar .sep { width: 1px; align-self: stretch; margin: 2px 4px; background: var(--line); }
  .bar select { font: inherit; padding: 2px 4px; max-width: 260px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--line)); border-radius: 3px; }
  .bar .state { margin-left: auto; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .state.bad { color: var(--vscode-errorForeground); }
  #editor { flex: 1; min-height: 60px; }
  #resizer { flex: none; height: 4px; cursor: ns-resize; background: var(--line); }
  #results { flex: none; display: flex; flex-direction: column; min-height: 80px; }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); flex: none; }
  .tab { padding: 4px 12px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.on { border-bottom-color: var(--vscode-focusBorder); }
  .body { flex: 1; overflow: auto; }
  .grid { margin: 0 0 6px; }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--line); padding: 1px 6px; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); font-weight: 600; }
  td.n, th.n { color: var(--muted); text-align: right; }
  td.null { background: var(--vscode-editor-findMatchHighlightBackground, #ffff0033); font-style: italic; }
  td.on { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .messages { padding: 6px 10px; font-family: var(--vscode-editor-font-family); white-space: pre-wrap; }
  .messages .error { color: var(--vscode-errorForeground); }
  .messages [data-line] { cursor: pointer; text-decoration: underline dotted; }
  .status { flex: none; display: flex; border-top: 1px solid var(--line); }
  .status span { padding: 2px 10px; border-right: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status span:first-child { flex: 1; }
  .status .bad { color: var(--vscode-errorForeground); }
  [hidden] { display: none !important; }
</style></head><body>
<div class="bar">
  <button class="run" id="execute"></button><button id="cancel" disabled></button><button id="parse"></button>
  <span class="sep"></span>
  <button id="connect"></button>
  <select id="connection" hidden></select>
  <select id="database" hidden></select>
  <span class="state" id="state"></span>
</div>
<div id="editor"></div>
<div id="resizer" hidden></div>
<div id="results" hidden>
  <div class="tabs"><span class="tab on" data-tab="results" id="tabResults"></span><span class="tab" data-tab="messages" id="tabMessages"></span></div>
  <div class="body" id="body"></div>
  <div class="status" id="status"></div>
</div>
<script nonce="${nonce}">
  window.MonacoEnvironment = { getWorkerUrl: () => URL.createObjectURL(new Blob(["importScripts('${vs}/assets/${worker}');"], { type: 'text/javascript' })) };
</script>
<script nonce="${nonce}" src="${vs}/loader.js"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'pageError', message: String(e.message) }));
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  let T = {}, editor, monacoApi, state = null, run = null, tab = 'results', applyingText = false, typing, seq = 0, chosenFor = null;
  const pending = new Map();
  const ask = (m) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); vscode.postMessage({ ...m, id }); });
  const send = (m) => vscode.postMessage(m);

  function selectionOrAll() {
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) return { text: editor.getModel().getValueInRange(sel), firstLine: sel.startLineNumber - 1 };
    return { text: editor.getValue(), firstLine: 0 };
  }
  $('execute').onclick = () => send({ type: 'execute', ...selectionOrAll() });
  $('parse').onclick = () => send({ type: 'parse', ...selectionOrAll() });
  $('cancel').onclick = () => send({ type: 'cancel' });
  $('connect').onclick = () => send({ type: 'connect' });
  $('connection').onchange = (e) => {
    const v = e.target.value;
    e.target.value = 'current';
    send({ type: v === 'disconnect' ? 'disconnect' : 'connect' });
  };
  // VS's database drop-down: the server's databases, asked for when it opens
  async function loadDatabases() {
    const names = (await ask({ type: 'databases' })) || [];
    const cur = state?.database || '';
    $('database').innerHTML = [...new Set([cur, ...names].filter(Boolean))].map((n) => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  }
  $('database').onmousedown = $('database').onfocus = () => { if (!$('database').dataset.loaded) { $('database').dataset.loaded = '1'; loadDatabases(); } };
  $('database').onchange = (e) => send({ type: 'useDatabase', name: e.target.value });

  function drawState() {
    const s = state;
    $('execute').disabled = !!s?.running;
    $('cancel').disabled = !s?.running;
    $('connect').hidden = !!s;
    $('connection').hidden = $('database').hidden = !s;
    $('state').textContent = s ? s.status : T.notConnected;
    $('state').className = 'state' + (s?.error ? ' bad' : '');
    if (s) {
      $('connection').innerHTML = '<option value="current">\u{1F50C} ' + esc(s.server) + ' – ' + esc(s.user) + '</option><option value="change">' + esc(T.changeConnection) + '</option><option value="disconnect">' + esc(T.disconnect) + '</option>';
      const cur = s.database || '';
      if (![...$('database').options].some((o) => o.value === cur)) { $('database').innerHTML = '<option value="' + esc(cur) + '">' + esc(cur) + '</option>'; delete $('database').dataset.loaded; }
      $('database').value = cur;
      $('database').title = T.availableDatabases;
    }
    drawStatus();
  }
  function drawStatus() {
    if (!state || !run) return;
    $('status').innerHTML = '<span class="' + (state.error ? 'bad' : '') + '">' + esc(state.status) + '</span><span>' + esc(state.server) + '</span><span>' + esc(state.user) + '</span><span>' + esc(state.database) + '</span><span>' + esc(state.elapsed) + '</span><span>' + esc(state.rows) + '</span>';
  }
  function grid(set) {
    const head = '<tr><th class="n"></th>' + set.columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>';
    return '<div class="grid"><table>' + head + set.rows.map((r, i) => '<tr><td class="n">' + (i + 1) + '</td>' + r.map((c) => c.isNull ? '<td class="null">NULL</td>' : '<td title="' + esc(c.displayValue) + '">' + esc(c.displayValue) + '</td>').join('') + '</tr>').join('') + '</table></div>';
  }
  function drawResults() {
    $('results').hidden = $('resizer').hidden = !run;
    if (!run) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    $('body').innerHTML = tab === 'results' ? run.sets.map(grid).join('')
      : '<div class="messages">' + run.messages.map((m) => '<div class="' + (m.isError ? 'error' : '') + '"' + (m.line !== undefined && m.line !== null ? ' data-line="' + m.line + '"' : '') + '>' + esc(m.text) + '</div>').join('') + '</div>';
    drawStatus();
    editor?.layout();
  }
  document.querySelectorAll('.tab').forEach((el) => el.onclick = () => { tab = el.dataset.tab; drawResults(); });
  $('body').onclick = (e) => {
    const line = e.target.closest('[data-line]');
    if (line) { const n = Number(line.dataset.line) + 1; editor.setSelection(new monacoApi.Selection(n, 1, n, editor.getModel().getLineMaxColumn(n))); editor.revealLineInCenter(n); editor.focus(); return; }
    document.querySelectorAll('td.on').forEach((c) => c.classList.remove('on'));
    const cell = e.target.closest('td');
    if (cell && !cell.classList.contains('n')) cell.classList.add('on');
  };
  document.addEventListener('keydown', (e) => {
    const cell = document.querySelector('td.on');
    if (cell && (e.ctrlKey || e.metaKey) && e.key === 'c' && !editor.hasTextFocus()) navigator.clipboard.writeText(cell.classList.contains('null') ? 'NULL' : cell.textContent);
  });
  // the results' height, dragged as in SSMS's split
  $('resizer').onmousedown = (e) => {
    const startY = e.clientY, startH = $('results').offsetHeight;
    const move = (ev) => { $('results').style.height = Math.max(80, startH - (ev.clientY - startY)) + 'px'; editor.layout(); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  $('results').style.height = '45%';

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'reply') { pending.get(m.id)?.(m.value); pending.delete(m.id); }
    // For the tests: type a text, ask Monaco for suggestions as Ctrl+Space does, and say what its list shows.
    if (m.type === 'suggestTest' && editor) {
      editor.setValue(m.text);
      const end = editor.getModel().getFullModelRange().getEndPosition();
      editor.setPosition(end);
      editor.focus();
      editor.trigger('test', 'editor.action.triggerSuggest', {});
      setTimeout(() => send({ type: 'suggestShown', labels: [...document.querySelectorAll('.suggest-widget .monaco-list-row .label-name')].map((e) => e.textContent) }), m.wait || 4000);
    }
    if (m.type === 'init') init(m);
    if (m.type === 'state') { state = m.state; drawState(); }
    if (m.type === 'text' && editor && m.text !== editor.getValue()) { applyingText = true; editor.getModel().pushEditOperations([], [{ range: editor.getModel().getFullModelRange(), text: m.text }], () => null); applyingText = false; }
    if (m.type === 'markers' && monacoApi && editor) monacoApi.editor.setModelMarkers(editor.getModel(), 'sqltools', m.markers);
    if (m.type === 'run') {
      if (m.run.status !== 'running' && chosenFor !== m.run.started) { chosenFor = m.run.started; tab = m.run.hasError && !m.run.sets.some((s) => s.rows.length) ? 'messages' : 'results'; }
      run = m.run;
      drawResults();
    }
  });

  function init(m) {
    T = m.texts;
    $('execute').textContent = '▷ ' + T.execute; $('execute').title = T.execute + ' (Ctrl+Shift+E, F5)';
    $('cancel').textContent = '■ ' + T.cancel; $('parse').textContent = '✓ ' + T.parse; $('parse').title = T.parse + ' (Ctrl+F5)';
    $('connect').textContent = '\u{1F50C} ' + T.connect;
    $('tabResults').textContent = T.results; $('tabMessages').textContent = T.messages;
    drawState();
    require.config({ paths: { vs: '${vs}' } });
    require(['vs/editor/editor.main'], (monaco) => {
      monacoApi = window.monaco || monaco;
      const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
      const css = getComputedStyle(document.body);
      const color = (v, d) => (css.getPropertyValue(v).trim() || d);
      monacoApi.editor.defineTheme('csharpShooter', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: {
        'editor.background': color('--vscode-editor-background', dark ? '#1e1e1e' : '#ffffff'),
        'editor.foreground': color('--vscode-editor-foreground', dark ? '#d4d4d4' : '#000000'),
        'editorLineNumber.foreground': color('--vscode-editorLineNumber-foreground', '#858585'),
      } });
      editor = monacoApi.editor.create($('editor'), {
        value: m.text, language: 'sql', theme: 'csharpShooter', automaticLayout: true, minimap: { enabled: false },
        fontFamily: color('--vscode-editor-font-family', 'Consolas'), fontSize: parseFloat(color('--vscode-editor-font-size', '14')) || 14,
        scrollBeyondLastLine: false, renderLineHighlight: 'line', fixedOverflowWidgets: true,
      });
      editor.onDidChangeModelContent(() => {
        if (applyingText) return;
        clearTimeout(typing);
        typing = setTimeout(() => send({ type: 'edit', text: editor.getValue() }), 150);
      });
      const K = monacoApi.KeyMod, C = monacoApi.KeyCode;
      editor.addCommand(K.CtrlCmd | K.Shift | C.KeyE, () => $('execute').click());
      editor.addCommand(C.F5, () => $('execute').click());
      editor.addCommand(K.CtrlCmd | C.F5, () => $('parse').click());
      editor.addCommand(K.Alt | C.Pause, () => $('cancel').click());
      editor.addCommand(K.CtrlCmd | C.KeyS, () => { clearTimeout(typing); send({ type: 'edit', text: editor.getValue() }); send({ type: 'save' }); });
      // IntelliSense and hovers: the SQL Tools Service's, for the document behind the page
      monacoApi.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.', ' ', '['],
        async provideCompletionItems(model, position) {
          clearTimeout(typing);
          send({ type: 'edit', text: model.getValue() });
          const answer = (await ask({ type: 'complete', line: position.lineNumber - 1, character: position.column - 1 })) || { items: [] };
          const items = answer.items;
          const word = model.getWordUntilPosition(position);
          const range = new monacoApi.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          return { incomplete: answer.incomplete, suggestions: items.map((i) => ({ label: i.label, kind: i.kind, detail: i.detail, documentation: i.documentation, insertText: i.insertText,
            insertTextRules: i.snippet ? 4 : 0, sortText: i.sortText, filterText: i.filterText, range })) };
        },
      });
      monacoApi.languages.registerHoverProvider('sql', {
        async provideHover(model, position) {
          const parts = (await ask({ type: 'hover', line: position.lineNumber - 1, character: position.column - 1 })) || [];
          return parts.length ? { contents: parts.map((value) => ({ value })) } : null;
        },
      });
      editor.focus();
      send({ type: 'monacoReady' });
    });
  }
  send({ type: 'ready' });
</script></body></html>`;
}

module.exports = { registerSqlEditor, VIEW_TYPE };
