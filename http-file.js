// .http and .rest files as Visual Studio 2026's HTTP editor has them: coloured by REST Client's grammar
// (syntaxes/http.tmLanguage.json), "Wyślij żądanie" above each request, the response in a "Odpowiedź" panel beside the file
// (Kod stanu, Czas, Rozmiar; Treść, Nagłówki and Nieprzetworzone), and the HTTP environment of http-client.env.json chosen
// from the status bar ("env: <none>", as VS's Środowiska HTTP list), with VS's own Polish texts (WebTools' Rest.VS).
// A web project's OpenAPI document (from the running app, else its build's) becomes requests in {Project}.http beside it,
// and a response with a JSON body is held to its operation's schema, where it breaks it said in the panel (Passenger's
// Endpoints window does both).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
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
  pickProject: 'Choose the web project',
  noWebProject: 'There is no web project (Microsoft.NET.Sdk.Web) in the workspace.',
  readingDocument: 'Reading the OpenAPI document of {0}...',
  noDocument: 'No OpenAPI document of {0}: run the app (MapOpenApi serves /openapi/v1.json), or have its build write one (Microsoft.Extensions.ApiDescription.Server).',
  allThere: 'Every operation of the OpenAPI document of {0} already has a request in {1}.',
  generated: 'Requests generated from the OpenAPI document ({0}): {1}, in {2}.',
  schemaKept: 'The body matches the OpenAPI schema of {0}.',
  schemaBroken: 'The body does not match the OpenAPI schema of {0}:',
  missing: 'is missing, though its schema requires it',
  wrongType: '{0} was expected, not {1}',
  notListed: '{0} is not one of {1}',
  pattern: '{0} does not match its pattern {1}',
  extra: 'is not a member its schema has',
  nothing: 'nothing is allowed here',
  noneOf: "matches none of the {0} options of its schema's {1}",
  bothOf: "matches both {0} and {1} of its schema's oneOf, which allows exactly one",
  option: 'option {0}',
});

/** A check's texts in the UI's language. */
const says = () => ({
  missing: () => T.missing, type: (a, b) => T.wrongType(a, b), notListed: (a, b) => T.notListed(a, b), pattern: (a, b) => T.pattern(a, b),
  extra: () => T.extra, nothing: () => T.nothing, none: (choice, count) => T.noneOf(count, choice), many: (a, b) => T.bothOf(a, b), option: (n) => T.option(n),
});

const isWebProject = (file) => {
  try {
    return /<Project\s+Sdk="[^"]*\.Web"/i.test(fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ''));
  } catch {
    return false;
  }
};

/** The C# files' texts of a project (bin and obj aside), for the paths its code gives MapOpenApi. */
function csharpTexts(dir, depth = 0, texts = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return texts;
  }
  for (const entry of entries) {
    if (texts.length >= 400) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 6 && !/^(bin|obj|node_modules|\..*)$/i.test(entry.name)) csharpTexts(full, depth + 1, texts);
    else if (entry.isFile() && entry.name.endsWith('.cs')) {
      try {
        texts.push(fs.readFileSync(full, 'utf8'));
      } catch {
        // unread: passed over
      }
    }
  }
  return texts;
}

/** The project of a file: the .csproj in its folder or the nearest above it (up to `root`). */
function projectOf(file, root) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let found;
    try {
      found = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.csproj'));
    } catch {
      found = undefined;
    }
    if (found) return path.join(dir, found);
    if (!root || path.dirname(dir) === dir || path.resolve(dir).toLowerCase() === path.resolve(root).toLowerCase()) return undefined;
  }
}

const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB` : `${(bytes / 1048576).toFixed(1).replace(/\.0$/, '')} MB`);
const duration = (ms) => (ms < 1000 ? `${ms.toFixed(2).replace(/\.?0+$/, '')} ms` : `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s`);

function registerHttpFiles(context) {
  const state = { last: undefined, generated: undefined }; // the last response shown and requests generated (the tests read them)
  const documents = new Map(); // an app's OpenAPI document by origin, asked a moment ago: { at, read }
  const generatedFrom = new Map(); // the document each .http file's requests were generated from, this session
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
      const schema = await schemaCheck(document.uri, prepared, response).catch(() => null);
      if (schema) {
        state.last.schema = schema;
        show({ type: 'schema', ...schema, title: schema.breaks.length ? T.schemaBroken(schema.operation) : T.schemaKept(schema.operation) });
      }
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

  /** The OpenAPI document of the app a request went to: asked of it where it is on this machine (kept 10 s), else the one
   *  the file's requests were generated from, else the one the build of the file's project wrote. */
  const documentFor = async (uri, url) => {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    const project = projectOf(uri.fsPath, folderOf(uri));
    let known = documents.get(origin);
    if (!known || Date.now() - known.at > 10000) {
      known = { at: Date.now(), read: h.openApiFromApp(origin, project ? h.mappedOpenApiPaths(csharpTexts(path.dirname(project))) : [], 3000) };
      documents.set(origin, known);
    }
    return (await known.read)?.document || generatedFrom.get(uri.fsPath.toLowerCase()) || (project && h.openApiFromBuild(project)?.document) || null;
  };

  const schemaCheck = async (uri, prepared, response) => {
    if (!/json/i.test(response.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '')) return null;
    const document = await documentFor(uri, prepared.url);
    return document && h.checkResponse(document, prepared.method, prepared.url, response, says());
  };

  /** Requests from a web project's OpenAPI document, into {Project}.http beside it: those of operations the file does not
   *  call yet, {{baseUrl}} the HTTP environment's or else set in the file from the launch profiles. */
  const generate = async (target) => {
    let project = target?.file || (target instanceof vscode.Uri ? target.fsPath : typeof target === 'string' ? target : undefined);
    if (!project || !project.toLowerCase().endsWith('.csproj')) {
      const found = (await vscode.workspace.findFiles('**/*.csproj', '**/{node_modules,bin,obj}/**')).map((u) => u.fsPath).filter(isWebProject).sort();
      if (!found.length) {
        vscode.window.showWarningMessage(T.noWebProject);
        return undefined;
      }
      project = found.length === 1 ? found[0]
        : (await vscode.window.showQuickPick(found.map((f) => ({ label: path.basename(f, '.csproj'), description: vscode.workspace.asRelativePath(f), file: f })), { placeHolder: T.pickProject }))?.file;
      if (!project) return undefined;
    }
    const name = path.basename(project, path.extname(project));
    const file = path.join(path.dirname(project), `${name}.http`);
    const uri = vscode.Uri.file(file);
    const envs = environmentsOf(uri).all;
    const fromEnvironment = [envs[chosen()], ...Object.values(envs)].map((e) => e?.baseUrl).find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    const launched = h.launchUrls(project);
    const read = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: T.readingDocument(name) }, async () => {
      const mapped = h.mappedOpenApiPaths(csharpTexts(path.dirname(project)));
      for (const url of new Set([fromEnvironment, ...launched].filter(Boolean))) {
        const answer = await h.openApiFromApp(url, mapped, 5000);
        if (answer) return { document: answer.document, source: answer.url };
      }
      const built = h.openApiFromBuild(project);
      return built && { document: built.document, source: built.file };
    });
    if (!read) {
      vscode.window.showWarningMessage(T.noDocument(name));
      return undefined;
    }
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // {{baseUrl}}: the environments' where any of them has it, else the file's own, from the launch profiles.
    const anyBaseUrl = Object.values(envs).some((e) => e && 'baseUrl' in e);
    const { text, operations } = h.openApiRequests(read.document, existing, 'baseUrl', anyBaseUrl ? undefined : launched[0] || 'http://localhost:5000');
    generatedFrom.set(file.toLowerCase(), read.document);
    state.generated = { file, source: read.source, operations: operations.map((o) => `${o.method} ${o.path}`) };
    if (!operations.length) {
      vscode.window.showInformationMessage(T.allThere(name, path.basename(file)));
    } else {
      fs.writeFileSync(file, existing + text);
      vscode.window.showInformationMessage(T.generated(read.document.title || name, operations.length, path.basename(file)));
    }
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    if (operations.length && existing) {
      const line = existing.split(/\r?\n/).length;
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
    }
    return state.generated;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('csharpShooter.http.send', send),
    vscode.commands.registerCommand('csharpShooter.http.generateFromOpenApi', generate),
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
  .schema { margin: 0 0 10px; } .schema.kept { color: var(--muted); } .schema.broken > div { color: var(--vscode-errorForeground); }
  .schema ul { margin: 4px 0 0; padding-left: 20px; } .schema code { font-family: var(--vscode-editor-font-family); }
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
    const schema = !last.schema ? '' : '<div class="schema ' + (last.schema.breaks.length ? 'broken' : 'kept') + '"><div>' + esc(last.schema.title) + '</div>' +
      (last.schema.breaks.length ? '<ul>' + last.schema.breaks.map((b) => '<li><code>' + esc(b.at) + '</code>: ' + esc(b.said) + '</li>').join('') + '</ul>' : '') + '</div>';
    $('root').innerHTML = '<div class="summary"><span>' + esc(T.statusCode) + ' <b class="' + (last.ok ? 'ok' : 'bad') + '">' + esc(last.status) + '</b></span><span>' + esc(T.time) + esc(last.time) + '</span><span>' + esc(T.size) + esc(last.size) + '</span></div>' + schema +
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
    if (m.type === 'schema' && last) { last.schema = m; render(); }
  });
</script></body></html>`;
  }

  return { state, send, generate };
}

module.exports = { registerHttpFiles };
