// .http and .rest files as Visual Studio 2026's HTTP editor has them: coloured by REST Client's grammar
// (syntaxes/http.tmLanguage.json), "Wyślij żądanie" above each request, the response in a "Odpowiedź" panel beside the file
// (Kod stanu, Czas, Rozmiar; Treść, Nagłówki and Nieprzetworzone), and the HTTP environment of http-client.env.json chosen
// from the status bar ("env: <none>", as VS's Środowiska HTTP list), with VS's own Polish texts (WebTools' Rest.VS).
const vscode = require('vscode');
const { table } = require('./l10n');
const h = require('./http-requests');

const T = table({
  send: 'Send request',
  title: 'Response',
  statusCode: 'Status code:',
  time: 'Time: ',
  size: 'Size: ',
  body: 'Body',
  headers: 'Headers',
  raw: 'Raw',
  name: 'Name',
  value: 'Value',
  sending: 'Sending...',
  cancel: 'Cancel',
  cancelled: 'The request was cancelled',
  error: 'Error',
  noResponse: 'There is no response yet',
  sendingTo: 'Sending the request to {0}...',
  done: 'Request completed...',
  undefinedVariable: 'The variable "{0}" is not defined.',
  notAbsolute: '{0} is not a valid absolute URI.',
  environments: 'HTTP environments (F6)',
  envFormat: 'env: {0}',
  none: '<none>',
  rawRequest: '=== REQUEST ===',
  rawResponse: '=== RESPONSE ===',
});

const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB` : `${(bytes / 1048576).toFixed(1).replace(/\.0$/, '')} MB`);
const duration = (ms) => (ms < 1000 ? `${ms.toFixed(2).replace(/\.?0+$/, '')} ms` : `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s`);

function registerHttpFiles(context) {
  const state = { last: undefined }; // the last response shown (the tests read it)
  let panel;
  let running;

  const folderOf = (uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  const environmentsOf = (uri) => h.environments(uri.fsPath, folderOf(uri));
  const chosen = () => context.workspaceState.get('csharpShooter.httpEnvironment') || '';

  // "env: <name>" in the status bar while an .http file is in front, as VS's editor bar has Środowiska HTTP (F6).
  const envItem = vscode.window.createStatusBarItem('csharpShooter.httpEnvironment', vscode.StatusBarAlignment.Right, 100);
  envItem.name = T.environments;
  envItem.command = 'csharpShooter.http.environment';
  envItem.tooltip = T.environments;
  const showEnv = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'http') return envItem.hide();
    envItem.text = `$(globe) ${T.envFormat(chosen() || T.none)}`;
    return envItem.show();
  };
  context.subscriptions.push(envItem, vscode.window.onDidChangeActiveTextEditor(showEnv));
  showEnv();

  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'http' }, {
    provideCodeLenses: (document) => h.parse(document.getText()).requests.map((r) => new vscode.CodeLens(new vscode.Range(r.line, 0, r.line, 0),
      { title: `$(play) ${T.send}`, command: 'csharpShooter.http.send', arguments: [document.uri, r.line] })),
  }));

  const show = (message) => {
    if (!panel) {
      panel = vscode.window.createWebviewPanel('csharpShooter.httpResponse', T.title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
      panel.onDidDispose(() => { panel = undefined; });
      panel.webview.onDidReceiveMessage((m) => m.type === 'cancel' && running?.abort());
      panel.webview.html = html();
    }
    panel.webview.postMessage(message);
  };

  /** Sends the request whose lines hold `line` (the CodeLens's, else the cursor's). */
  const send = async (uri, line) => {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document) return undefined;
    const at = line ?? vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const { requests, variables } = h.parse(document.getText());
    const request = requests.find((r) => r.line <= at && at <= r.end) || requests.find((r) => r.line >= at);
    if (!request) return undefined;
    const environment = environmentsOf(document.uri).all[chosen()] || {};
    let prepared;
    try {
      prepared = h.prepare(request, variables, environment, { undefined: (n) => T.undefinedVariable(n), notAbsolute: (u) => T.notAbsolute(u) });
    } catch (e) {
      state.last = { error: e.message };
      show({ type: 'error', text: e.message });
      return state.last;
    }
    running?.abort();
    const controller = new AbortController();
    running = controller;
    show({ type: 'sending' });
    const status = vscode.window.setStatusBarMessage(`$(sync~spin) ${T.sendingTo(prepared.url)}`);
    try {
      const response = await h.send(prepared, controller.signal);
      let body = response.body;
      try {
        if (/json/i.test(response.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '')) body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // not JSON after all: as it came
      }
      state.last = { prepared, response };
      show({ type: 'response', status: `${response.status} ${response.statusText}`, ok: response.status < 400, time: duration(response.ms), size: size(response.bytes),
        body, headers: response.headers, raw: h.raw(prepared, response, { request: T.rawRequest, response: T.rawResponse }) });
      vscode.window.setStatusBarMessage(T.done, 5000);
    } catch (e) {
      const text = controller.signal.aborted ? T.cancelled : e.cause?.message || e.message;
      state.last = { error: text };
      show({ type: 'error', text });
    } finally {
      status.dispose();
      if (running === controller) running = undefined;
    }
    return state.last;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('csharpShooter.http.send', send),
    vscode.commands.registerCommand('csharpShooter.http.environment', async (name) => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const names = uri ? Object.keys(environmentsOf(uri).all) : [];
      const picked = typeof name === 'string' ? { value: name } : await vscode.window.showQuickPick([{ label: T.none, value: '' }, ...names.map((n) => ({ label: n, value: n }))],
        { placeHolder: T.environments });
      if (!picked) return;
      await context.workspaceState.update('csharpShooter.httpEnvironment', picked.value);
      showEnv();
    }),
  );

  function html() {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const texts = { body: T.body, headers: T.headers, raw: T.raw, name: T.name, value: T.value, sending: T.sending, cancel: T.cancel, error: T.error, statusCode: T.statusCode, time: T.time, size: T.size };
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  body { margin: 0; padding: 10px 14px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .summary { display: flex; gap: 18px; align-items: center; margin-bottom: 10px; }
  .summary b.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .summary b.bad { color: var(--vscode-errorForeground); }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
  .tabs button { font: inherit; padding: 4px 12px; cursor: pointer; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; }
  .tabs button.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  table { border-collapse: collapse; } td, th { text-align: left; padding: 3px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .message { color: var(--muted); } .error { color: var(--vscode-errorForeground); }
  button.cancel { font: inherit; padding: 3px 12px; margin-left: 8px; cursor: pointer; border: 0; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
</style></head><body>
<div id="root" class="message">${esc(T.noResponse)}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify(texts)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  let last, tab = (vscode.getState() || {}).tab || 'body';
  const render = () => {
    if (!last) return;
    const pane = tab === 'headers' ? '<table><tr><th>' + esc(T.name) + '</th><th>' + esc(T.value) + '</th></tr>' + last.headers.map(([n, v]) => '<tr><td>' + esc(n) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</table>'
      : '<pre>' + esc(tab === 'raw' ? last.raw : last.body) + '</pre>';
    $('root').className = '';
    $('root').innerHTML = '<div class="summary"><span>' + esc(T.statusCode) + ' <b class="' + (last.ok ? 'ok' : 'bad') + '">' + esc(last.status) + '</b></span><span>' + esc(T.time) + esc(last.time) + '</span><span>' + esc(T.size) + esc(last.size) + '</span></div>' +
      '<div class="tabs">' + [['body', T.body], ['headers', T.headers], ['raw', T.raw]].map(([k, l]) => '<button data-tab="' + k + '" class="' + (k === tab ? 'on' : '') + '">' + esc(l) + '</button>').join('') + '</div>' + pane;
  };
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; vscode.setState({ tab }); render(); }
    if (e.target.id === 'cancel') vscode.postMessage({ type: 'cancel' });
  });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'sending') { $('root').className = 'message'; $('root').innerHTML = esc(T.sending) + '<button class="cancel" id="cancel">' + esc(T.cancel) + '</button>'; }
    if (m.type === 'error') { last = undefined; $('root').className = 'error'; $('root').textContent = T.error + ': ' + m.text; }
    if (m.type === 'response') { last = m; render(); }
  });
</script></body></html>`;
  }

  return { state, send };
}

module.exports = { registerHttpFiles };
