// T-SQL in .sql files as in SQL Server Management Studio 22: IntelliSense from the database a query window is connected
// to, and that connection in the status bar (server, login, database), through Microsoft's SQL Tools Service (MIT; the
// server behind vscode-mssql), started on the installed .NET as the C# server is, once a .sql file is open. A window
// connects through SSMS's Connect dialog (sql-connect-dialog.js): SSMS's own recent connections with their remembered
// passwords (ssms-connections.js), this extension's, the solution's connection strings (appsettings*.json and the
// projects' user secrets) and this machine's servers; a new query window takes the last connection.
const vscode = require('vscode');
const { table, tn, language } = require('./l10n');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { LanguageClient, State } = require('vscode-languageclient/node');
const { parseJsonc } = require('./launch');
const sqlConnection = require('./sql-connection');
const ssms = require('./ssms-connections');
const { showConnectDialog } = require('./sql-connect-dialog');
const { registerSqlResults } = require('./sql-results');
const { registerSqlObjectExplorer } = require('./sql-object-explorer');
const { registerSqlEditor } = require('./sql-editor');

const { build, fieldsOf, describe, withChange, masked, parse, windowsUser } = sqlConnection;

// SSMS's own words (its ConnectionDlg, ConnectionDlg.UI and SqlEditors resources), in English and Polish (l10n/pl.json).
const T = table({
  connectToServer: 'Connect to Server',
  defaultDatabase: '<default>',
  trustCertificate: 'Trust server certificate',
  connecting: 'Connecting...',
  connected: 'Connected.',
  notConnected: 'not connected',
  disconnected: 'Disconnected.',
  newConnectionOpened: 'New Connection Opened',
  executing: 'Executing query...',
  executedSuccessfully: 'Query executed successfully.',
  completedWithErrors: 'Query completed with errors.',
  queryCanceled: 'Query canceled.',
  userAndSpid: '{0} ({1})',
  disconnect: 'Disconnect',
  availableDatabases: 'Available Databases',
  changeConnection: 'Change Connection...',
  connect: 'Connect',
  execute: 'Execute',
  parse: 'Parse',
  cancel: 'Cancel',
  cancelQuery: 'Cancel Executing Query',
  preparing: 'Preparing IntelliSense...',
  statusTip: 'Server: {0}\nLogin: {1}\nDatabase: {2}',
  failed: 'Cannot connect to {0}: {1}',
  certificateFailed: 'The certificate of {0} is not trusted. Connect trusting it?',
  noServer: 'SQL Tools Service not found: {0}. Run "npm run fetch-sqltools" in the extension folder.',
  noSqlEditor: 'Open a .sql file first.',
});

const CERTIFICATE = /certificate|certyfikat|SSL|TLS|pre-login|uzgadniania przed logowaniem/i;

/** The ConnectionStrings of a project's appsettings*.json and of its user secrets (UserSecretsId of the .csproj next to
 *  it), the secrets winning as in ASP.NET Core's configuration. */
async function solutionConnections() {
  const found = [];
  const files = await vscode.workspace.findFiles('**/appsettings*.json', '**/{node_modules,bin,obj}/**', 100);
  for (const file of files) {
    let settings;
    try {
      settings = parseJsonc(fs.readFileSync(file.fsPath, 'utf8'));
    } catch {
      continue;
    }
    const strings = { ...(settings?.ConnectionStrings || {}) };
    for (const [name, value] of Object.entries(userSecrets(path.dirname(file.fsPath)))) strings[name] = value;
    for (const [name, connectionString] of Object.entries(strings)) {
      if (typeof connectionString === 'string' && connectionString.includes('=')) {
        found.push({ key: `${vscode.workspace.asRelativePath(file)}#${name}`, name, file: vscode.workspace.asRelativePath(file), connectionString });
      }
    }
  }
  return found;
}

function userSecrets(dir) {
  try {
    const project = fs.readdirSync(dir).find((f) => f.endsWith('.csproj'));
    const id = project && /<UserSecretsId>([^<]+)<\/UserSecretsId>/.exec(fs.readFileSync(path.join(dir, project), 'utf8'))?.[1].trim();
    if (!id) return {};
    const file = process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'Microsoft', 'UserSecrets', id, 'secrets.json')
      : path.join(os.homedir(), '.microsoft', 'usersecrets', id, 'secrets.json');
    const secrets = parseJsonc(fs.readFileSync(file, 'utf8'));
    const out = { ...(secrets.ConnectionStrings || {}) };
    for (const [key, value] of Object.entries(secrets)) if (/^ConnectionStrings:/i.test(key)) out[key.split(':')[1]] = value;
    return out;
  } catch {
    return {};
  }
}

/** One connection per server, database, authentication and login, as SSMS's history keeps them. */
const keyOf = (f) => [f.server, f.database, f.authentication, f.authentication === 'Integrated' ? '' : f.user].join('|').toLowerCase();
const userOf = (f) => (f.authentication === 'Integrated' ? windowsUser() : f.user);
/** "server, database (login)", as SSMS's Recent Connections list them. */
const labelOf = (f) => `${f.server}, ${f.database || T.defaultDatabase} (${userOf(f)})`;

function registerSql(context) {
  const output = vscode.window.createOutputChannel('CSharpShooter SQL');
  const windows = new Map(); // document uri -> { conn, state: 'connecting' | 'preparing' | 'connected', summary }
  const completions = new Map(); // owner uri -> resolve of connection/complete
  const ready = new Map(); // owner uri -> resolve of textDocument/intelliSenseReady
  let client;
  let starting;
  let missingShown = false;
  let probes = 0;
  const queries = new Map(); // owner uri -> the running query's handlers
  const listeners = new Map(); // STS notification -> the object explorer's handlers
  const openings = new Map(); // document uri -> its connecting when it opened
  const fullStrings = new Map(); // server key -> its connection string with the password, for this session
  let nextConnection; // the connection string a query window opened by New Query connects to
  let explorer;
  const results = registerSqlResults(context);

  context.subscriptions.push(output);

  const isSql = (doc) => doc?.languageId === 'sql' && doc.uri.scheme !== 'git';
  let editors; // the SQL editor pages (sql-editor.js)
  // The query window in front: VS Code's text editor of a .sql, else the SQL editor page in front.
  // While focus moves (a dialog closing), the last one in front that is still on screen.
  let lastActive;
  const activeDoc = () => {
    const text = vscode.window.activeTextEditor?.document;
    const doc = isSql(text) ? text : editors?.active();
    if (doc) return (lastActive = doc);
    if (lastActive && !vscode.window.activeTextEditor && (editors?.has(lastActive) || vscode.window.visibleTextEditors.some((e) => e.document === lastActive))) return lastActive;
    return undefined;
  };
  const owner = (doc) => client.code2ProtocolConverter.asUri(doc.uri);
  const recent = () => context.globalState.get('csharpShooter.sql.recent', []);
  const secretOf = (key) => `csharpShooter.sql.${key}`;

  // The query window's status bar as Visual Studio's SQL editor has it (QEStatusBarManager): its state on the left
  // (New Connection Opened, Executing query..., Query executed successfully.), then server (version), login (SPID),
  // database (Available Databases on a click), the last query's time and rows.
  const item = (id, priority, align = vscode.StatusBarAlignment.Right) => {
    const it = vscode.window.createStatusBarItem(`csharpShooter.sql.${id}`, align, priority);
    it.name = `SQL: ${id}`;
    context.subscriptions.push(it);
    return it;
  };
  const items = { state: item('state', 90, vscode.StatusBarAlignment.Left), server: item('server', 105), user: item('user', 104),
    database: item('database', 103), time: item('time', 102), rows: item('rows', 101) };

  function showStatus() {
    lensesChanged?.fire();
    editors?.update();
    const doc = activeDoc();
    const all = Object.values(items);
    if (!isSql(doc)) {
      all.forEach((it) => it.hide());
      vscode.commands.executeCommand('setContext', 'csharpShooter.sqlConnected', false);
      vscode.commands.executeCommand('setContext', 'csharpShooter.sqlRunning', false);
      return;
    }
    const window = windows.get(doc.uri.toString());
    vscode.commands.executeCommand('setContext', 'csharpShooter.sqlConnected', !!window);
    vscode.commands.executeCommand('setContext', 'csharpShooter.sqlRunning', !!window?.running);
    // the SQL editor page has VS's status line under its results: the window's status bar would say it twice
    if (editors.has(doc) && vscode.window.activeTextEditor?.document !== doc) {
      all.forEach((it) => it.hide());
      return;
    }
    if (!window) {
      all.forEach((it) => it.hide());
      items.state.text = `$(debug-disconnect) ${T.disconnected}`;
      items.state.tooltip = T.connectToServer;
      items.state.command = 'csharpShooter.sql.connect';
      items.state.show();
      return;
    }
    const { server, user, database } = window.summary;
    const run = runOf(doc);
    const state = window.state === 'connecting' ? ['sync~spin', T.connecting]
      : window.running ? ['sync~spin', T.executing]
      : run?.status === 'cancelled' ? ['circle-slash', T.queryCanceled]
      : run ? (run.hasError ? ['error', T.completedWithErrors] : ['pass', T.executedSuccessfully])
      : window.state === 'preparing' ? ['sync~spin', T.preparing]
      : ['plug', T.newConnectionOpened];
    items.state.text = `$(${state[0]}) ${state[1]}`;
    items.state.tooltip = T.statusTip(server, user, database || T.defaultDatabase);
    items.state.command = 'csharpShooter.sql.changeDatabase';
    items.server.text = window.version ? `${server} (${window.version})` : server;
    items.user.text = window.spid ? T.userAndSpid(user, window.spid) : user;
    items.database.text = `$(database) ${database || T.defaultDatabase}`;
    items.database.tooltip = T.availableDatabases;
    items.database.command = window.state === 'connecting' ? undefined : 'csharpShooter.sql.changeDatabase';
    items.time.text = run?.elapsed || '00:00:00';
    items.rows.text = tn(run?.rowCount || 0, '{0} row', '{0} rows');
    all.forEach((it) => it.show());
  }

  // Visual Studio's SQL editor toolbar inside the editor, above the first line (a code lens row): Execute or Cancel,
  // Parse, the connection (Change Connection on a click) and the database as VS's drop-down (Available Databases).
  const lensesChanged = new vscode.EventEmitter();
  const lens = (range, title, command, tooltip) => new vscode.CodeLens(range, { title, command, tooltip });
  context.subscriptions.push(lensesChanged, vscode.languages.registerCodeLensProvider({ language: 'sql' }, {
    onDidChangeCodeLenses: lensesChanged.event,
    provideCodeLenses(doc) {
      const range = new vscode.Range(0, 0, 0, 0);
      const window = windows.get(doc.uri.toString());
      if (!window) return [lens(range, `$(plug) ${T.connect}`, 'csharpShooter.sql.connect', T.connectToServer)];
      const { server, user, database } = window.summary;
      return [
        window.running ? lens(range, `$(debug-stop) ${T.cancel}`, 'csharpShooter.sql.cancelQuery', T.cancelQuery)
          : lens(range, `$(play) ${T.execute}`, 'csharpShooter.sql.execute', `${T.execute} (Ctrl+Shift+E, F5)`),
        lens(range, `$(check) ${T.parse}`, 'csharpShooter.sql.parse', `${T.parse} (Ctrl+F5)`),
        lens(range, `$(server) ${server} (${user})`, 'csharpShooter.sql.changeConnection', T.changeConnection),
        lens(range, `$(database) ${database || T.defaultDatabase} $(chevron-down)`, 'csharpShooter.sql.changeDatabase', T.availableDatabases),
      ];
    },
  }));

  function start() {
    if (client) return Promise.resolve(client);
    if (starting) return starting;
    const configured = vscode.workspace.getConfiguration('csharpShooter').get('sqlToolsPath');
    const dll = configured || context.asAbsolutePath(path.join('sqltools', 'MicrosoftSqlToolsServiceLayer.dll'));
    if (!fs.existsSync(dll)) {
      if (!missingShown) vscode.window.showErrorMessage(T.noServer(dll));
      missingShown = true;
      return Promise.resolve(undefined);
    }
    const logDir = path.join(context.logUri.fsPath, 'sqltools');
    const dataDir = context.globalStorageUri.fsPath;
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const args = [dll, '--log-file', path.join(logDir, 'sqltools.log'), '--locale', language(),
      '--application-name', 'CSharpShooter', '--data-path', dataDir, '--parallel-message-processing'];
    const next = new LanguageClient('csharpShooterSql', 'T-SQL (SQL Tools Service)', { command: 'dotnet', args },
      { documentSelector: [{ language: 'sql', scheme: 'file' }, { language: 'sql', scheme: 'untitled' }], outputChannel: output });
    next.onNotification('connection/complete', (params) => completions.get(params.ownerUri)?.(params));
    next.onNotification('textDocument/intelliSenseReady', (params) => ready.get(params.ownerUri)?.());
    next.onNotification('query/message', (p) => queries.get(p.ownerUri)?.message(p.message));
    next.onNotification('query/resultSetComplete', (p) => queries.get(p.ownerUri)?.resultSet(p.resultSetSummary));
    next.onNotification('query/complete', (p) => queries.get(p.ownerUri)?.complete(p));
    for (const method of ['objectexplorer/sessioncreated', 'objectexplorer/expandCompleted']) {
      next.onNotification(method, (p) => (listeners.get(method) || []).forEach((listen) => listen(p)));
    }
    starting = next.start().then(() => (client = next), (e) => {
      starting = undefined;
      output.appendLine(String(e?.stack || e));
      throw e;
    });
    return starting;
  }

  /** STS's connection/connect for an owner uri, resolved with its connection/complete: { connectionId } or the error's
   *  first line. A server whose certificate is not trusted is asked about, as SSMS asks, and connected to again trusting
   *  it (remembered for that server). */
  async function open(uri, connectionString) {
    const { server } = describe(connectionString);
    const trusted = context.globalState.get('csharpShooter.sql.trusted', []);
    if (trusted.includes(server.toLowerCase())) connectionString = withChange(connectionString, { trustServerCertificate: true });
    const complete = new Promise((r) => completions.set(uri, r));
    const accepted = await client.sendRequest('connection/connect', { ownerUri: uri, connection: { options: { connectionString } } });
    const result = accepted ? await complete : { errorMessage: 'connection/connect refused' };
    completions.delete(uri);
    if (result.connectionId) return { ...result, connectionString };
    const error = result.errorMessage || (result.messages || '').split(/\r?\n/)[0];
    output.appendLine(`${server}: ${result.messages || error}`);
    if (!fieldsOf(connectionString).trustServerCertificate && CERTIFICATE.test(`${error} ${result.messages}`)
      && (await vscode.window.showWarningMessage(T.certificateFailed(server), { modal: true }, T.trustCertificate)) === T.trustCertificate) {
      await context.globalState.update('csharpShooter.sql.trusted', [...trusted, server.toLowerCase()]);
      return open(uri, withChange(connectionString, { trustServerCertificate: true }));
    }
    return { error };
  }

  /** Connects the query window to a connection string: { ok } or { error }. */
  async function connect(doc, conn) {
    if (!(await start())) return { error: T.noServer('') };
    const uri = owner(doc);
    if (windows.has(doc.uri.toString())) await disconnect(doc);
    const summary = describe(conn.connectionString);
    const window = { conn, state: 'connecting', summary };
    windows.set(doc.uri.toString(), window);
    showStatus();
    const intellisense = new Promise((r) => ready.set(uri, r));
    const result = await open(uri, conn.connectionString);
    if (windows.get(doc.uri.toString()) !== window) return { error: 'cancelled' };
    if (result.error) {
      windows.delete(doc.uri.toString());
      ready.delete(uri);
      showStatus();
      return { error: result.error };
    }
    window.conn = { connectionString: result.connectionString };
    window.summary = { ...summary, database: result.connectionSummary?.databaseName || summary.database, user: result.connectionSummary?.userName || summary.user };
    // "16.0 RTM", as VS shows the server's version; the session's SPID next to the login.
    const info = result.serverInfo;
    if (info) window.version = `${info.serverMajorVersion}.${info.serverMinorVersion} ${info.serverLevel || ''}`.trim();
    client.sendRequest('query/simpleexecute', { ownerUri: uri, queryString: 'SELECT @@SPID' })
      .then((r) => { window.spid = r?.rows?.[0]?.[0]?.displayValue; showStatus(); }, () => {});
    window.state = 'preparing';
    showStatus();
    intellisense.then(() => {
      ready.delete(uri);
      if (windows.get(doc.uri.toString()) !== window) return;
      window.state = 'connected';
      showStatus();
    });
    return { ok: true };
  }

  async function disconnect(doc) {
    const window = windows.get(doc.uri.toString());
    if (!window) return;
    windows.delete(doc.uri.toString());
    showStatus();
    if (client) await client.sendRequest('connection/disconnect', { ownerUri: owner(doc) }).catch(() => {});
  }

  /** The dialog's lists: this extension's recent connections and SSMS's (one entry for the same connection), the
   *  solution's connection strings and this machine's servers. */
  async function entries() {
    const ours = recent().map((r) => ({ key: r.key, origin: 'recent', removable: true, fields: r.fields, label: labelOf(r.fields), base: r.base }));
    const known = new Set(ours.map((e) => e.key));
    const theirs = ssms.recentConnections().map((s) => ({ ...s, key: `ssms:${keyOf(s.fields)}` })).filter((s) => !known.has(s.key.slice(5)))
      .map((s) => ({ key: s.key, origin: 'ssms', fields: s.fields, label: labelOf(s.fields), detail: `${labelOf(s.fields)} (SQL Server Management Studio)`, ssms: s }));
    const solution = (await solutionConnections()).map((c) => {
      const fields = fieldsOf(c.connectionString);
      return { key: `app:${c.key}`, origin: 'appsettings', fields, label: `${c.name}: ${fields.server}, ${fields.database || T.defaultDatabase}`, detail: c.file, base: c.connectionString };
    });
    const local = (await ssms.localServers()).map((server) => ({ key: `local:${server}`, origin: 'local', label: server,
      fields: { server, authentication: 'Integrated', user: '', database: '', encrypt: 'Mandatory', trustServerCertificate: false, hostNameInCertificate: '' } }));
    const strip = (e) => ({ key: e.key, origin: e.origin, removable: e.removable, label: e.label, detail: e.detail, fields: e.fields });
    entries.last = { all: [...ours, ...theirs, ...solution, ...local] };
    return { history: [...ours, ...theirs].map(strip), solution: solution.map(strip), local: local.map(strip) };
  }
  const entry = (key) => entries.last?.all.find((e) => e.key === key);

  /** The connection string of the dialog's fields, on the chosen entry's own (its other keys kept), with the password
   *  typed, else the entry's: SSMS's unprotected, this extension's from the secret storage, the solution's as written. */
  async function connectionStringOf(fields, password, key) {
    const e = key && entry(key);
    if (!e) return { connectionString: build('', fields, password), password };
    if (e.origin === 'ssms') {
      const base = build(e.ssms.connectionString, e.ssms.fields, '');
      const pw = password ?? (await ssms.rememberedPassword(e.ssms));
      return { connectionString: build(base, fields, pw), password: pw };
    }
    if (e.origin === 'recent') {
      const pw = password ?? (await context.secrets.get(secretOf(e.key)));
      return { connectionString: build(e.base, fields, pw), password: pw };
    }
    const pw = password ?? parse(e.base || '').find(([k]) => /^(password|pwd)$/i.test(k))?.[1];
    return { connectionString: build(e.base || '', fields, pw), password: pw };
  }

  /** Keeps a connection made through the dialog among the recent ones, newest first: the connection string without its
   *  password, which goes to the secret storage when Remember Password is ticked. */
  async function rememberConnection(fields, connectionString, password, rememberPassword) {
    const key = keyOf(fields);
    const kept = { key, fields: { ...fields, hasPassword: !!(rememberPassword && password) }, base: build(connectionString, fields, '') };
    await context.globalState.update('csharpShooter.sql.recent', [kept, ...recent().filter((r) => r.key !== key)].slice(0, 20));
    if (rememberPassword && password) await context.secrets.store(secretOf(key), password);
    else await context.secrets.delete(secretOf(key));
    await context.workspaceState.update('csharpShooter.sql.last', { kind: 'recent', key });
  }

  /** SSMS's Connect dialog for the query window: resolves to whether it connected. */
  function connectDialog(doc) {
    return showConnectDialog({
      entries,
      pinned: () => context.globalState.get('csharpShooter.sql.pinned', []),
      pin: (key, on) => context.globalState.update('csharpShooter.sql.pinned',
        [...context.globalState.get('csharpShooter.sql.pinned', []).filter((k) => k !== key), ...(on ? [key] : [])]),
      remove: async (key) => {
        await context.globalState.update('csharpShooter.sql.recent', recent().filter((r) => r.key !== key));
        await context.secrets.delete(secretOf(key));
      },
      preview: async (fields, password, key) => masked(build(key && entry(key)?.base || '', fields, password ?? (key && fields.authentication !== 'Integrated' ? '********' : undefined))),
      fromString: (text) => {
        const pw = parse(text).find(([k]) => /^(password|pwd)$/i.test(k))?.[1];
        return { fields: fieldsOf(text), password: pw && pw !== '********' ? pw : undefined };
      },
      databases: async (fields, password, key) => {
        if (!(await start())) return [];
        const { connectionString } = await connectionStringOf({ ...fields, database: '' }, password, key);
        const uri = `csharpshooter-sql-probe:${++probes}`;
        const result = await open(uri, connectionString);
        if (result.error) return [];
        const { databaseNames = [] } = await client.sendRequest('connection/listdatabases', { ownerUri: uri }).catch(() => ({}));
        client.sendRequest('connection/disconnect', { ownerUri: uri }).catch(() => {});
        return databaseNames;
      },
      connect: async (fields, password, key, rememberPassword) => {
        const { connectionString, password: pw } = await connectionStringOf(fields, password, key);
        let connected;
        if (doc) {
          const outcome = await connect(doc, { connectionString });
          if (!outcome.ok) return { error: T.failed(fields.server, outcome.error) };
          connected = windows.get(doc.uri.toString()).conn.connectionString;
        } else {
          // Add SQL Server: the server goes into the SQL Server Object Explorer once it answers.
          if (!(await start())) return { error: T.noServer('') };
          const uri = `csharpshooter-sql-probe:${++probes}`;
          const result = await open(uri, connectionString);
          if (result.error) return { error: T.failed(fields.server, result.error) };
          client.sendRequest('connection/disconnect', { ownerUri: uri }).catch(() => {});
          connected = result.connectionString;
        }
        if (key?.startsWith('app:')) await context.workspaceState.update('csharpShooter.sql.last', { kind: 'appsettings', key: key.slice(4) });
        else await rememberConnection(fields, connectionString, pw, rememberPassword);
        await addServer(fields, connected);
        if (doc) await reveal(doc);
        return { ok: true };
      },
    });
  }

  // The SQL Server Object Explorer's servers: as the history keeps them (no password), the password from the secret
  // storage or, for this session, from the connection made.
  const servers = () => context.globalState.get('csharpShooter.sql.servers', []).map((s) => ({ ...s, user: userOf(s.fields) }));
  async function addServer(fields, connectionString) {
    const key = keyOf({ ...fields, database: '' });
    fullStrings.set(key, connectionString);
    if (servers().some((s) => s.key === key)) return;
    const kept = { key, fields: { ...fields, database: '' }, base: build(connectionString, { ...fields, database: '' }, '') };
    await context.globalState.update('csharpShooter.sql.servers', [...context.globalState.get('csharpShooter.sql.servers', []), kept]);
    explorer?.refresh();
  }
  async function serverConnectionString(server) {
    if (fullStrings.has(server.key)) return withChange(fullStrings.get(server.key), { database: '' });
    if (server.fields.authentication === 'Integrated') return server.base;
    const password = await context.secrets.get(secretOf(keyOf(server.fields)))
      ?? (await context.secrets.get(secretOf(recent().find((r) => keyOf({ ...r.fields, database: '' }) === server.key)?.key || '')));
    return password === undefined ? undefined : build(server.base, server.fields, password);
  }

  /** A query window opens in the editor .sql files open in: the SQL editor page, unless workbench.editorAssociations
   *  gives *.sql VS Code's text editor ("default"). */
  async function show(doc) {
    const associations = vscode.workspace.getConfiguration('workbench').get('editorAssociations') || {};
    const chosen = associations['*.sql'] ?? Object.entries(associations).find(([k]) => /\*\.sql$/i.test(k))?.[1];
    if (chosen === 'default') return vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, editors.VIEW_TYPE);
  }

  /** A new query window connected to a connection string, with a query in it, run when asked (Select Top 1000 Rows). */
  async function newQuery(connectionString, text, run) {
    nextConnection = connectionString;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: text || '' });
    await show(doc);
    await (openings.get(doc.uri.toString()) || opened(doc));
    if (run && windows.has(doc.uri.toString())) return runQuery(doc, doc.getText(), 0);
    return doc;
  }

  /** Execute (Visual Studio's Ctrl+Shift+E, SSMS's F5): the selection, or the whole window, run on its connection; a
   *  window not connected yet asks for one first, as SSMS does. The SQL editor page sends its own selection. */
  async function execute() {
    const editor = vscode.window.activeTextEditor;
    const doc = activeDoc();
    if (!doc) return vscode.window.showInformationMessage(T.noSqlEditor);
    if (doc !== editor?.document) return executeText(doc, doc.getText(), 0);
    const range = editor.selection.isEmpty ? new vscode.Range(0, 0, doc.lineCount, 0) : editor.selection;
    return executeText(doc, doc.getText(range), range.start.line);
  }
  async function executeText(doc, text, firstLine) {
    if (!windows.has(doc.uri.toString()) && !(await connectDialog(doc))) return undefined;
    return runQuery(doc, text, firstLine);
  }
  const reveal = (doc) => (editors.has(doc) ? editors.reveal(doc) : vscode.window.showTextDocument(doc));
  const runOf = (doc) => editors.sink(doc)?.run() || results.run(doc);

  /** Runs a query on the window's connection: the results and messages go to the Results panel as they come (up to
   *  MAX_ROWS rows of a result set), an error's line counted from the window's. Resolves to the run. */
  const MAX_ROWS = 2000;
  async function runQuery(doc, text, firstLine) {
    const uri = owner(doc);
    if (queries.has(uri)) return undefined;
    const window = windows.get(doc.uri.toString());
    const shown = (editors.sink(doc) || results).start(doc, window.summary);
    window.running = true;
    showStatus();
    const started = Date.now();
    let sets = Promise.resolve();
    const finished = new Promise((resolveComplete) => queries.set(uri, {
      message: (m) => shown.message(m.message, m.isError, m.isError && m.errorSelection ? m.errorSelection.startLine + firstLine : undefined),
      resultSet: (s) => (sets = sets.then(async () => {
        const count = Math.min(s.rowCount, MAX_ROWS);
        const subset = count ? await client.sendRequest('query/subset', { ownerUri: uri, batchIndex: s.batchId, resultSetIndex: s.id, rowsStartIndex: 0, rowsCount: count }) : { resultSubset: { rows: [] } };
        shown.resultSet({ columns: s.columnInfo.map((c) => c.columnName), rows: subset.resultSubset.rows.map((r) => r.map((c) => ({ displayValue: c.displayValue, isNull: c.isNull }))), rowCount: s.rowCount, truncated: s.rowCount > count });
      })),
      complete: resolveComplete,
    }));
    try {
      await client.sendRequest('query/executeString', { ownerUri: uri, query: text });
      await finished;
      await sets;
    } catch (e) {
      shown.message(String(e?.message || e), true);
    } finally {
      queries.delete(uri);
    }
    const ms = Date.now() - started;
    const elapsed = new Date(ms).toISOString().slice(11, 19);
    shown.finish(shown.run.cancelled ? 'cancelled' : 'done', elapsed);
    window.running = false;
    showStatus();
    return shown.run;
  }

  /** Parse (Visual Studio's and SSMS's): the selection, or the whole window, checked by the server under SET PARSEONLY,
   *  as SSMS sends it, without running; its errors in Messages with their lines. */
  async function parse() {
    const editor = vscode.window.activeTextEditor;
    const doc = activeDoc();
    if (!doc) return vscode.window.showInformationMessage(T.noSqlEditor);
    if (doc !== editor?.document) return parseText(doc, doc.getText(), 0);
    const range = editor.selection.isEmpty ? new vscode.Range(0, 0, doc.lineCount, 0) : editor.selection;
    return parseText(doc, doc.getText(range), range.start.line);
  }
  async function parseText(doc, text, firstLine) {
    if (!windows.has(doc.uri.toString()) && !(await connectDialog(doc))) return undefined;
    return runQuery(doc, `SET PARSEONLY ON\nGO\n${text}\nGO\nSET PARSEONLY OFF`, firstLine - 2);
  }

  async function cancelQuery(doc = activeDoc()) {
    if (!doc || !client || !queries.has(owner(doc))) return;
    const run = runOf(doc);
    if (run) run.cancelled = true;
    await client.sendRequest('query/cancel', { ownerUri: owner(doc) }).catch(() => {});
  }

  /** Connect: SSMS's dialog, or a given source (the tests, and a new window's last connection). */
  async function connectCommand(source) {
    const doc = activeDoc();
    if (!doc) return vscode.window.showInformationMessage(T.noSqlEditor);
    if (!source) return connectDialog(doc);
    const conn = await resolve(source);
    if (!conn) return false;
    const outcome = await connect(doc, conn);
    if (!outcome.ok) {
      vscode.window.showErrorMessage(T.failed(describe(conn.connectionString).server, outcome.error));
      return false;
    }
    await context.workspaceState.update('csharpShooter.sql.last', source);
    return true;
  }

  /** The connection a remembered choice stands for now: a solution's string as the file has it today, a recent one with
   *  its password from the secret storage (none when it was not remembered and is needed). */
  async function resolve(source) {
    if (source.kind === 'appsettings') {
      const found = (await solutionConnections()).find((c) => c.key === source.key);
      return found && { connectionString: found.connectionString };
    }
    const r = recent().find((x) => x.key === source.key);
    if (!r) return undefined;
    if (r.fields.authentication === 'Integrated') return { connectionString: r.base };
    const password = await context.secrets.get(secretOf(r.key));
    return password === undefined ? undefined : { connectionString: build(r.base, r.fields, password) };
  }

  /** SSMS's Available Databases list, with Change Connection and Disconnect after it. */
  async function changeDatabase(name, doc = activeDoc()) {
    const window = doc && windows.get(doc.uri.toString());
    if (!window) return connectCommand();
    if (name === undefined) {
      const { databaseNames = [] } = await client.sendRequest('connection/listdatabases', { ownerUri: owner(doc) }).catch(() => ({}));
      // VS's database list: the server's databases only, the current one picked (connection changes are the toolbar's).
      const items = databaseNames.map((d) => ({ label: `$(database) ${d}`, description: d === window.summary.database ? '$(check)' : '', current: d === window.summary.database, database: d }));
      const pick = vscode.window.createQuickPick();
      pick.title = T.availableDatabases;
      pick.placeholder = `${window.summary.server} (${window.summary.user})`;
      pick.items = items;
      pick.activeItems = items.filter((i) => i.current);
      name = await new Promise((resolve) => {
        pick.onDidAccept(() => resolve(pick.selectedItems[0]?.database));
        pick.onDidHide(() => resolve(undefined));
        pick.show();
      });
      pick.dispose();
    }
    if (name === undefined || name === window.summary.database) return;
    const uri = owner(doc);
    const changed = await client.sendRequest('connection/changedatabase', { ownerUri: uri, newDatabase: name }).catch(() => false);
    const connectionString = withChange(window.conn.connectionString, { database: name });
    if (!changed) return connect(doc, { connectionString });
    window.conn = { connectionString };
    window.summary = { ...window.summary, database: name };
    window.state = 'preparing';
    showStatus();
    const intellisense = new Promise((r) => ready.set(uri, r));
    client.sendNotification('textDocument/rebuildIntelliSense', { ownerUri: uri });
    intellisense.then(() => {
      ready.delete(uri);
      if (windows.get(doc.uri.toString()) === window) window.state = 'connected';
      showStatus();
    });
    return true;
  }

  /** A query window that opens connects to the last connection of this workspace, as SSMS's New Query takes the
   *  current one; one whose password is not remembered waits for Connect. */
  function opened(doc) {
    if (!isSql(doc) || windows.has(doc.uri.toString()) || openings.has(doc.uri.toString())) return openings.get(doc.uri.toString());
    const given = nextConnection;
    nextConnection = undefined;
    const opening = (async () => {
      if (!(await start())) return;
      const last = context.workspaceState.get('csharpShooter.sql.last');
      const conn = given ? { connectionString: given } : last && (await resolve(last));
      if (conn) await connect(doc, conn);
      else showStatus();
    })().finally(() => openings.delete(doc.uri.toString()));
    openings.set(doc.uri.toString(), opening);
    return opening;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('csharpShooter.sql.connect', connectCommand),
    vscode.commands.registerCommand('csharpShooter.sql.disconnect', () => {
      const doc = activeDoc();
      return doc && disconnect(doc);
    }),
    vscode.commands.registerCommand('csharpShooter.sql.changeDatabase', changeDatabase),
    vscode.commands.registerCommand('csharpShooter.sql.changeConnection', () => {
      const doc = activeDoc();
      return doc ? connectDialog(doc) : vscode.window.showInformationMessage(T.noSqlEditor);
    }),
    vscode.commands.registerCommand('csharpShooter.sql.newQuery', () => newQuery(undefined, '', false)),
    vscode.commands.registerCommand('csharpShooter.sql.execute', execute),
    vscode.commands.registerCommand('csharpShooter.sql.cancelQuery', cancelQuery),
    vscode.commands.registerCommand('csharpShooter.sql.parse', parse),
    vscode.window.onDidChangeActiveTextEditor(showStatus),
    vscode.workspace.onDidOpenTextDocument(opened),
    vscode.workspace.onDidCloseTextDocument((doc) => isSql(doc) && disconnect(doc)),
    { dispose: () => client && client.state !== State.Stopped && client.stop() },
  );
  editors = registerSqlEditor(context, {
    state: (doc) => {
      const w = windows.get(doc.uri.toString());
      return w && { summary: w.summary, version: w.version, spid: w.spid, state: w.state, running: w.running, run: runOf(doc) };
    },
    execute: executeText,
    parse: parseText,
    cancel: cancelQuery,
    connect: (doc) => connectDialog(doc),
    disconnect,
    databases: async (doc) => {
      if (!client || !windows.has(doc.uri.toString())) return [];
      return (await client.sendRequest('connection/listdatabases', { ownerUri: owner(doc) }).catch(() => ({}))).databaseNames || [];
    },
    useDatabase: (doc, name) => changeDatabase(name, doc),
    activated: showStatus,
  });
  explorer = registerSqlObjectExplorer(context, {
    start,
    request: async (method, params) => (await start()).sendRequest(method, params),
    on: (method, listen) => listeners.set(method, [...(listeners.get(method) || []), listen]),
    servers,
    connectionString: serverConnectionString,
    withDatabase: (connectionString, database) => withChange(connectionString, { database }),
    addServer: () => connectDialog(undefined),
    forget: (server) => context.globalState.update('csharpShooter.sql.servers', context.globalState.get('csharpShooter.sql.servers', []).filter((s) => s.key !== server.key)),
    newQuery,
  });
  for (const doc of vscode.workspace.textDocuments) opened(doc);
  showStatus();
  // For the tests: the window's connection and IntelliSense state, the dialog last opened, runs and the explorer.
  return {
    connect, disconnect, changeDatabase, connectCommand, solutionConnections, entries, execute, parse, runQuery, items, newQuery, servers,
    window: (doc) => windows.get(doc.uri.toString()),
    dialog: () => showConnectDialog.last,
    results, explorer: () => explorer, editors: () => editors,
  };
}

module.exports = { registerSql };
