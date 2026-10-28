// SQL Server Management Studio 22's Connect dialog as a page: History (Favorites, Recent Connections, filtered as typed)
// and Browse (the solution's connection strings, this machine's servers) above, the Connection Properties (server name,
// authentication, user name and password, database name loaded from the server, Encrypt, Trust Server Certificate, host
// name in certificate) and the Connection String below, Reset, Connect and Cancel at the bottom; its texts SSMS's own
// (Microsoft.SqlServer.ConnectionDlg.UI's resources). A password never reaches the page: an entry's remembered one stays
// with the extension, which uses it when the field is left as it is.
const vscode = require('vscode');
const { table } = require('./l10n');

const T = table({
  title: 'Connect',
  history: 'History',
  browse: 'Browse',
  filter: 'Type here to filter the list',
  favorites: 'Favorites',
  noFavorites: 'No favorite connections',
  recent: 'Recent Connections',
  solution: 'Solution',
  localServers: 'Local Servers',
  pin: 'Pin',
  unpin: 'Unpin',
  remove: 'Remove from History',
  properties: 'Connection Properties',
  connectionString: 'Connection String',
  serverName: 'Server Name',
  authentication: 'Authentication',
  windowsAuth: 'Windows Authentication',
  sqlAuth: 'SQL Server Authentication',
  userName: 'User Name',
  password: 'Password',
  rememberPassword: 'Remember Password',
  databaseName: 'Database Name',
  defaultDatabase: '<default>',
  loadingDatabases: 'loading databases',
  encrypt: 'Encrypt',
  mandatory: 'Mandatory',
  optional: 'Optional',
  strict: 'Strict (Minimum SQL 2022 or Azure SQL)',
  trustCertificate: 'Trust Server Certificate',
  hostName: 'Host name in certificate',
  apply: 'Apply the connection string to the connection properties tab',
  reset: 'Reset',
  connect: 'Connect',
  cancel: 'Cancel',
  connecting: 'Connecting...',
  missingServer: 'Server name is required.',
  missingUser: 'User name is required.',
});

/** Opens the dialog. host: entries() → { history: [...], solution: [...], local: [...] } of { key, label, detail,
 *  origin, removable, fields }; pinned(), pin(key, on), remove(key); preview(fields, password, key) → the masked
 *  connection string; fromString(text) → { fields, password }; databases(fields, password, key) → names;
 *  connect(fields, password, key, remember) → { ok } or { error }. password is undefined when the field was left as
 *  the entry has it. Resolves to whether it connected. */
function showConnectDialog(host) {
  // Beside the query, as a side pane the way the chat opens, filling its width; it closes once connected.
  const panel = vscode.window.createWebviewPanel('csharpShooter.sqlConnect', T.title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true });
  const dialog = { panel, posted: [] }; // for the tests: what the page was sent
  const post = (m) => (dialog.posted.push(m), panel.webview.postMessage(m));
  let done;
  const result = new Promise((r) => (done = r));
  let lists;

  async function refresh() {
    lists = await host.entries();
    post({ type: 'entries', ...lists, pinned: host.pinned() });
  }
  const find = (key) => [...lists.history, ...lists.solution, ...lists.local].find((e) => e.key === key);

  dialog.receive = async (m) => {
    try {
      if (m.type === 'ready') return refresh();
      if (m.type === 'select') {
        const entry = find(m.key);
        return entry && post({ type: 'fields', key: entry.key, fields: entry.fields });
      }
      if (m.type === 'pin') return (await host.pin(m.key, m.on), refresh());
      if (m.type === 'remove') return (await host.remove(m.key), refresh());
      if (m.type === 'preview') return post({ type: 'preview', text: await host.preview(m.fields, m.password, m.key) });
      if (m.type === 'applyString') {
        const { fields, password } = host.fromString(m.text);
        return post({ type: 'fields', key: m.key, fields, password });
      }
      if (m.type === 'databases') return post({ type: 'databases', names: await host.databases(m.fields, m.password, m.key) });
      if (m.type === 'cancel') return panel.dispose();
      if (m.type === 'connect') {
        post({ type: 'state', busy: true });
        const outcome = await host.connect(m.fields, m.password, m.key, m.remember);
        if (outcome.ok) {
          done(true);
          return panel.dispose();
        }
        return post({ type: 'state', busy: false, error: outcome.error });
      }
    } catch (e) {
      post({ type: 'state', busy: false, error: String(e?.message || e) });
    }
  };
  panel.webview.onDidReceiveMessage(dialog.receive);
  panel.onDidDispose(() => done(false));
  panel.webview.html = html();
  dialog.result = result;
  showConnectDialog.last = dialog;
  return result;
}

function html() {
  const nonce = String(Math.random()).slice(2);
  const texts = Object.fromEntries(Object.keys(T).map((k) => [k, T[k]]));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-widget-border, var(--vscode-panel-border, #8884)); --muted: var(--vscode-descriptionForeground);
    --accent: var(--vscode-focusBorder, #6c4ad6); }
  body { margin: 0; padding: 18px 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .win { padding: 0 20px; }
  h1 { font-size: 1.6em; font-weight: 600; margin: 0 0 14px; }
  .tabs { display: flex; gap: 18px; align-items: center; margin-bottom: 8px; }
  .tab { padding: 2px 0 4px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.on { border-bottom-color: var(--accent); }
  .tabs .grow { flex: 1; }
  .toggle { width: 22px; height: 22px; border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; padding: 0; }
  input, select, textarea { font: inherit; box-sizing: border-box; width: 100%; padding: 4px 7px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 3px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  input:focus, select:focus, textarea:focus { outline: none; border-bottom: 2px solid var(--accent); }
  input:disabled { opacity: .55; }
  .list { height: clamp(170px, 32vh, 420px); overflow: auto; margin: 8px 0 0; border-bottom: 1px solid var(--line); }
  .group { padding: 5px 4px; cursor: pointer; user-select: none; }
  .group::before { content: '⌄'; display: inline-block; width: 18px; }
  .group.shut::before { content: '›'; }
  .empty { padding: 3px 4px 6px 22px; }
  .item { display: flex; align-items: center; gap: 7px; padding: 4px 6px 4px 22px; cursor: pointer; position: relative; white-space: nowrap; }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.on { background: var(--vscode-list-inactiveSelectionBackground); }
  .item.on::before { content: ''; position: absolute; left: 12px; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background: var(--accent); }
  .item .db { width: 12px; height: 13px; flex: none; border-radius: 6px / 3px; background: currentColor; opacity: .85; }
  .item .text { overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .item .acts { display: none; gap: 2px; }
  .item:hover .acts { display: flex; }
  .item .acts button { border: none; background: none; color: inherit; cursor: pointer; padding: 0 4px; }
  .item .from { color: var(--muted); font-size: .85em; }
  .form { display: grid; grid-template-columns: minmax(120px, 170px) 1fr; gap: 7px 10px; align-items: center; margin-top: 10px; }
  .form label.check { grid-column: 2; display: flex; align-items: center; gap: 8px; }
  .form label.check input { width: auto; accent-color: var(--accent); }
  textarea { height: 130px; resize: vertical; margin-top: 10px; }
  .row { display: flex; justify-content: flex-end; margin-top: 4px; }
  .foot { display: flex; gap: 10px; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
  .foot .grow { flex: 1; }
  button.btn { font: inherit; min-width: 90px; padding: 4px 14px; border: 1px solid var(--line); border-radius: 4px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  button.btn:disabled { opacity: .6; cursor: default; }
  .status { min-height: 1.3em; margin-top: 8px; white-space: pre-wrap; }
  .status.error { color: var(--vscode-errorForeground); }
  [hidden] { display: none !important; }
</style></head><body><div class="win">
<h1>${esc(T.title)}</h1>
<div class="tabs" id="topTabs"><span class="tab on" data-tab="history">${esc(T.history)}</span><span class="tab" data-tab="browse">${esc(T.browse)}</span>
  <span class="grow"></span><button class="toggle" id="toggle" title="${esc(T.history)}">◧</button></div>
<div id="lists">
  <input id="filter" placeholder="${esc(T.filter)}" title="${esc(T.filter)}">
  <div class="list" id="list"></div>
</div>
<div class="tabs" style="margin-top:12px" id="formTabs"><span class="tab on" data-tab="properties">${esc(T.properties)}</span><span class="tab" data-tab="string">${esc(T.connectionString)}</span></div>
<div id="properties" class="form">
  <span>${esc(T.serverName)}</span><input id="server" list="servers" autocomplete="off"><datalist id="servers"></datalist>
  <span>${esc(T.authentication)}</span><select id="authentication"><option value="Integrated">${esc(T.windowsAuth)}</option><option value="SqlLogin">${esc(T.sqlAuth)}</option></select>
  <span>${esc(T.userName)}</span><input id="user" autocomplete="off">
  <span>${esc(T.password)}</span><input id="password" type="password" autocomplete="off">
  <label class="check"><input type="checkbox" id="remember"> ${esc(T.rememberPassword)}</label>
  <span>${esc(T.databaseName)}</span><input id="database" list="databases" autocomplete="off" placeholder="${esc(T.defaultDatabase)}"><datalist id="databases"></datalist>
  <span>${esc(T.encrypt)}</span><select id="encrypt"><option value="Mandatory">${esc(T.mandatory)}</option><option value="Optional">${esc(T.optional)}</option><option value="Strict">${esc(T.strict)}</option></select>
  <label class="check"><input type="checkbox" id="trust"> ${esc(T.trustCertificate)}</label>
  <span>${esc(T.hostName)}</span><input id="hostName" autocomplete="off">
</div>
<div id="string" hidden><textarea id="text" spellcheck="false"></textarea><div class="row"><button class="btn" id="apply" title="${esc(T.apply)}">✓</button></div></div>
<div class="status" id="status"></div>
<div class="foot"><button class="btn" id="reset">${esc(T.reset)}</button><span class="grow"></span>
  <button class="btn primary" id="connect">${esc(T.connect)}</button><button class="btn" id="cancel">${esc(T.cancel)}</button></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify(texts)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const send = (m) => vscode.postMessage(m);
  let data = { history: [], solution: [], local: [], pinned: [] };
  let tab = 'history', key = null, stored = false, typedPassword = false;
  const shut = new Set();
  const DEFAULTS = { server: '', authentication: 'Integrated', user: '', database: '', encrypt: 'Mandatory', trustServerCertificate: false, hostNameInCertificate: '' };

  function fields() {
    return { server: $('server').value.trim(), authentication: $('authentication').value, user: $('user').value.trim(), database: $('database').value.trim(),
      encrypt: $('encrypt').value, trustServerCertificate: $('trust').checked, hostNameInCertificate: $('hostName').value.trim() };
  }
  // The typed password; undefined leaves the entry's remembered one to the extension, '' is none.
  const password = () => (typedPassword ? $('password').value : stored ? undefined : '');
  function setFields(f, hasStored) {
    f = { ...DEFAULTS, ...f };
    $('server').value = f.server; $('user').value = f.user; $('database').value = f.database; $('hostName').value = f.hostNameInCertificate;
    if (![...$('authentication').options].some((o) => o.value === f.authentication)) $('authentication').add(new Option(f.authentication, f.authentication));
    $('authentication').value = f.authentication; $('encrypt').value = f.encrypt; $('trust').checked = !!f.trustServerCertificate;
    stored = !!hasStored; typedPassword = false;
    $('password').value = stored ? '\\u2022'.repeat(12) : '';
    $('remember').checked = stored;
    $('databases').innerHTML = '';
    authChanged();
  }
  function authChanged() {
    const windows = $('authentication').value === 'Integrated';
    $('user').disabled = $('password').disabled = $('remember').disabled = windows;
    if (windows) $('user').placeholder = '';
  }
  function item(e, pinned) {
    const acts = '<span class="acts"><button data-pin="' + esc(e.key) + '" title="' + esc(pinned ? T.unpin : T.pin) + '">' + (pinned ? '★' : '☆') + '</button>'
      + (e.removable ? '<button data-remove="' + esc(e.key) + '" title="' + esc(T.remove) + '">✕</button>' : '') + '</span>';
    return '<div class="item' + (e.key === key ? ' on' : '') + '" data-key="' + esc(e.key) + '" title="' + esc(e.detail || e.label) + '"><span class="db"></span><span class="text">'
      + esc(e.label) + (e.origin === 'ssms' ? ' <span class="from">SSMS</span>' : '') + '</span>' + acts + '</div>';
  }
  function group(id, title, entries, empty) {
    const q = $('filter').value.trim().toLowerCase();
    const shown = entries.filter((e) => !q || (e.label + ' ' + (e.detail || '')).toLowerCase().includes(q));
    let h = '<div class="group' + (shut.has(id) ? ' shut' : '') + '" data-group="' + id + '">' + esc(title) + '</div>';
    if (!shut.has(id)) h += shown.length ? shown.map((e) => item(e, data.pinned.includes(e.key))).join('') : '<div class="empty">' + esc(empty || '') + '</div>';
    return h;
  }
  function render() {
    const all = [...data.history, ...data.solution, ...data.local];
    if (tab === 'history') {
      const favorites = data.pinned.map((k) => all.find((e) => e.key === k)).filter(Boolean);
      $('list').innerHTML = group('favorites', T.favorites, favorites, T.noFavorites) + group('recent', T.recent + ' (' + data.history.length + ')', data.history);
    } else {
      $('list').innerHTML = group('solution', T.solution, data.solution) + group('local', T.localServers, data.local);
    }
    $('servers').innerHTML = [...new Set(all.map((e) => e.fields.server))].map((s) => '<option value="' + esc(s) + '">').join('');
  }
  $('list').onclick = (ev) => {
    const pin = ev.target.closest('[data-pin]'), remove = ev.target.closest('[data-remove]'), g = ev.target.closest('[data-group]'), it = ev.target.closest('[data-key]');
    if (pin) return send({ type: 'pin', key: pin.dataset.pin, on: !data.pinned.includes(pin.dataset.pin) });
    if (remove) return send({ type: 'remove', key: remove.dataset.remove });
    if (g) { shut.has(g.dataset.group) ? shut.delete(g.dataset.group) : shut.add(g.dataset.group); return render(); }
    if (it) { key = it.dataset.key; render(); send({ type: 'select', key }); }
  };
  $('list').ondblclick = (ev) => ev.target.closest('[data-key]') && connect();
  $('filter').oninput = render;
  document.querySelectorAll('#topTabs .tab').forEach((el) => el.onclick = () => {
    tab = el.dataset.tab;
    document.querySelectorAll('#topTabs .tab').forEach((t) => t.classList.toggle('on', t === el));
    render();
  });
  $('toggle').onclick = () => { $('lists').hidden = !$('lists').hidden; };
  document.querySelectorAll('#formTabs .tab').forEach((el) => el.onclick = () => {
    document.querySelectorAll('#formTabs .tab').forEach((t) => t.classList.toggle('on', t === el));
    $('properties').hidden = el.dataset.tab !== 'properties';
    $('string').hidden = el.dataset.tab !== 'string';
    if (el.dataset.tab === 'string') send({ type: 'preview', fields: fields(), password: password(), key });
  });
  $('apply').onclick = () => send({ type: 'applyString', text: $('text').value, key });
  $('authentication').onchange = authChanged;
  $('password').oninput = () => { typedPassword = true; };
  $('password').onfocus = () => { if (stored && !typedPassword) $('password').select(); };
  // A field that names another server or login is not the entry's any more: its remembered password is not for it.
  for (const id of ['server', 'user', 'authentication']) $(id).addEventListener('change', () => { if (stored && !typedPassword) { stored = false; $('password').value = ''; } });
  $('database').onfocus = () => {
    if ($('databases').options.length || !fields().server) return;
    $('database').placeholder = T.loadingDatabases;
    send({ type: 'databases', fields: fields(), password: password(), key });
  };
  function connect() {
    const f = fields();
    if (!f.server) return status(T.missingServer, true);
    if (f.authentication !== 'Integrated' && !f.user) return status(T.missingUser, true);
    send({ type: 'connect', fields: f, password: password(), key, remember: $('remember').checked });
  }
  function status(text, error) { $('status').textContent = text || ''; $('status').className = 'status' + (error ? ' error' : ''); }
  $('connect').onclick = connect;
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') connect(); if (e.key === 'Escape') send({ type: 'cancel' }); });
  $('cancel').onclick = () => send({ type: 'cancel' });
  $('reset').onclick = () => { key = null; setFields({}); render(); status(''); };
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'entries') {
      data = m;
      render();
      if (key === null && data.history[0]) { key = data.history[0].key; render(); setFields(data.history[0].fields, data.history[0].fields.hasPassword); }
    }
    if (m.type === 'fields') {
      key = m.key;
      setFields(m.fields, m.fields.hasPassword && m.password === undefined);
      if (m.password !== undefined) { $('password').value = m.password; typedPassword = true; }
      render();
    }
    if (m.type === 'preview') $('text').value = m.text;
    if (m.type === 'databases') {
      $('database').placeholder = T.defaultDatabase;
      $('databases').innerHTML = (m.names || []).map((n) => '<option value="' + esc(n) + '">').join('');
    }
    if (m.type === 'state') {
      $('connect').disabled = m.busy;
      status(m.busy ? T.connecting : m.error, !m.busy && !!m.error);
    }
  });
  setFields({});
  send({ type: 'ready' });
</script></body></html>`;
}

module.exports = { showConnectDialog };
