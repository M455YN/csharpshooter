// A query window's results as SQL Server Management Studio 22 and Visual Studio 2026 show them under the query, here in
// the bottom panel: the Results tab (a grid per result set, NULL marked as SSMS marks it), the Messages tab (an error's
// line opens in the query), and the status line (Query executed successfully, server, login, database, elapsed time,
// rows). It shows the results of the query window in front.
const vscode = require('vscode');
const { table, tn } = require('./l10n');

// SSMS's words (its SqlEditors resources).
const T = table({
  results: 'Results',
  messages: 'Messages',
  executing: 'Executing query...',
  succeeded: 'Query executed successfully.',
  failed: 'Query completed with errors.',
  cancelled: 'Query was canceled by user.',
  completionTime: 'Completion time: {0}',
  truncated: 'The first {0} of {1} rows are shown.',
  empty: 'Run a query (Ctrl+Shift+E or F5) in a connected .sql window to see its results here.',
});

const VIEW = 'csharpShooter.sqlResults';

function registerSqlResults(context) {
  const runs = new Map(); // document uri -> the run shown for it
  let view;
  let shown; // the document uri whose run is shown
  const post = (m) => view?.webview.postMessage(m);
  const rows = (n) => tn(n, '{0} row', '{0} rows');

  function render() {
    const run = shown && runs.get(shown);
    post({ type: 'run', run: run && { ...run, rowsText: rows(run.rowCount || 0), statusText: run.status === 'running' ? T.executing : run.status === 'cancelled' ? T.cancelled : run.hasError ? T.failed : T.succeeded } });
  }

  const provider = {
    resolveWebviewView(v) {
      view = v;
      v.webview.options = { enableScripts: true };
      v.webview.html = html();
      v.webview.onDidReceiveMessage(async (m) => {
        if (m.type === 'ready') render();
        if (m.type === 'goto' && shown) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(shown));
          const editor = await vscode.window.showTextDocument(doc);
          const at = new vscode.Position(Math.max(0, m.line), 0);
          editor.selection = new vscode.Selection(at, doc.lineAt(at.line).range.end);
          editor.revealRange(editor.selection);
        }
      });
      v.onDidDispose(() => (view = undefined));
    },
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW, provider, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => {
    if (e?.document.languageId !== 'sql') return;
    shown = e.document.uri.toString();
    render();
  }));

  return {
    /** A new run for a query window: its results replace the last ones, and the panel comes up, as SSMS opens its pane. */
    start(doc, summary) {
      // The panel shows only once a text editor's query has results for it (the SQL editor page has its own).
      vscode.commands.executeCommand('setContext', 'csharpShooter.sqlResultsInPanel', true);
      const run = { status: 'running', summary, sets: [], messages: [], rowCount: 0, hasError: false, started: Date.now() };
      runs.set(doc.uri.toString(), run);
      shown = doc.uri.toString();
      render();
      vscode.commands.executeCommand(`${VIEW}.focus`, { preserveFocus: true }).then(() => vscode.window.showTextDocument(doc), () => {});
      return {
        run,
        resultSet(set) {
          run.sets.push(set);
          run.rowCount += set.rowCount;
          if (set.truncated) run.messages.push({ text: T.truncated(set.rows.length, set.rowCount) });
          render();
        },
        message(text, isError, line) {
          run.messages.push({ text, isError, line });
          run.hasError ||= isError;
          render();
        },
        finish(status, elapsed) {
          run.status = status;
          run.elapsed = elapsed;
          run.messages.push({ text: T.completionTime(new Date().toISOString()) });
          render();
        },
      };
    },
    /** For the tests: the run shown for a document. */
    run: (doc) => runs.get(doc.uri.toString()),
  };
}

function html() {
  const nonce = String(Math.random()).slice(2);
  const texts = { results: T.results, messages: T.messages, empty: T.empty };
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background)); }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); flex: none; }
  .tab { padding: 4px 12px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.on { border-bottom-color: var(--vscode-focusBorder); }
  .body { flex: 1; overflow: auto; }
  .grid { margin: 0 0 6px; border-bottom: 1px solid var(--line); }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--line); padding: 1px 6px; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); font-weight: 600; }
  td.n, th.n { color: var(--muted); text-align: right; background: var(--vscode-editorGroupHeader-tabsBackground, transparent); }
  td.null { background: var(--vscode-editor-findMatchHighlightBackground, #ffff0033); font-style: italic; }
  td.on { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .messages { padding: 6px 10px; font-family: var(--vscode-editor-font-family); white-space: pre-wrap; }
  .messages .error { color: var(--vscode-errorForeground); }
  .messages .error[data-line] { cursor: pointer; text-decoration: underline dotted; }
  .empty { padding: 10px; color: var(--muted); }
  .status { flex: none; display: flex; gap: 0; border-top: 1px solid var(--line); background: var(--vscode-statusBarItem-prominentBackground, transparent); }
  .status span { padding: 2px 10px; border-right: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status span:first-child { flex: 1; }
  .status .bad { color: var(--vscode-errorForeground); }
</style></head><body>
<div class="tabs"><span class="tab on" data-tab="results">${texts.results}</span><span class="tab" data-tab="messages">${texts.messages}</span></div>
<div class="body" id="body"></div>
<div class="status" id="status" hidden></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify(texts)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  let run, tab = 'results', chosenFor = null;
  document.querySelectorAll('.tab').forEach((el) => el.onclick = () => { tab = el.dataset.tab; draw(); });
  function grid(set) {
    const head = '<tr><th class="n"></th>' + set.columns.map((c) => '<th title="' + esc(c) + '">' + esc(c) + '</th>').join('') + '</tr>';
    const body = set.rows.map((r, i) => '<tr><td class="n">' + (i + 1) + '</td>' + r.map((c) => c.isNull ? '<td class="null">NULL</td>' : '<td title="' + esc(c.displayValue) + '">' + esc(c.displayValue) + '</td>').join('') + '</tr>').join('');
    return '<div class="grid"><table>' + head + body + '</table></div>';
  }
  function draw() {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    if (!run) { $('body').innerHTML = '<div class="empty">' + esc(T.empty) + '</div>'; $('status').hidden = true; return; }
    if (tab === 'results') $('body').innerHTML = run.sets.map(grid).join('');
    else $('body').innerHTML = '<div class="messages">' + run.messages.map((m) => '<div class="' + (m.isError ? 'error' : '') + '"' + (m.line !== undefined && m.line !== null ? ' data-line="' + m.line + '"' : '') + '>' + esc(m.text) + '</div>').join('') + '</div>';
    const s = run.summary || {};
    $('status').hidden = false;
    $('status').innerHTML = '<span class="' + (run.hasError ? 'bad' : '') + '">' + esc(run.statusText) + '</span><span>' + esc(s.server) + '</span><span>' + esc(s.user) + '</span><span>' + esc(s.database) + '</span><span>' + esc(run.elapsed || '') + '</span><span>' + esc(run.rowsText) + '</span>';
  }
  $('body').onclick = (e) => {
    const line = e.target.closest('[data-line]');
    if (line) return vscode.postMessage({ type: 'goto', line: Number(line.dataset.line) });
    const cell = e.target.closest('td');
    document.querySelectorAll('td.on').forEach((c) => c.classList.remove('on'));
    if (cell && !cell.classList.contains('n')) cell.classList.add('on');
  };
  document.addEventListener('keydown', (e) => {
    const cell = document.querySelector('td.on');
    if (cell && (e.ctrlKey || e.metaKey) && e.key === 'c') navigator.clipboard.writeText(cell.classList.contains('null') ? 'NULL' : cell.textContent);
  });
  window.addEventListener('message', ({ data: m }) => {
    if (m.type !== 'run') return;
    // A finished run with errors and no rows opens on its messages, as SSMS does.
    if (m.run && m.run.status !== 'running' && chosenFor !== m.run.started) { chosenFor = m.run.started; tab = m.run.hasError && !m.run.sets.some((s) => s.rows.length) ? 'messages' : 'results'; }
    run = m.run;
    draw();
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

module.exports = { registerSqlResults };
