// Checks .sql files' connections and IntelliSense in a real editor, against a SQL Server with a database ShooterSql
// holding a table dbo.Ludzie (Id, Imie, Nazwisko), on a workspace with a query.sql of 'SELECT * FROM dbo.', 'GO' and
// 'SELECT L. FROM dbo.Ludzie AS L', and whose appsettings.json has that server's connection
// string as ConnectionStrings:Local (with a // comment, as appsettings.json may have):
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/sql-suite.js node test/runTest.js
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(300);
  }
}

async function labels(doc, position) {
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, position);
  return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

async function run() {
  const api = await vscode.extensions.getExtension('M455YN.csharpshooter').activate();
  const { sql } = api;
  const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`ok   ${name}`), (e) => { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; });
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  let doc;

  await check("the solution's connection strings are offered, from appsettings.json with comments", async () => {
    const found = await sql.solutionConnections();
    assert.deepStrictEqual(found.map((c) => c.key), ['appsettings.json#Local']);
  });

  await check('a query window connects to one and IntelliSense knows its tables and columns', async () => {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'query.sql')));
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(await vscode.commands.executeCommand('csharpShooter.sql.connect', { kind: 'appsettings', key: 'appsettings.json#Local' }), true);
    const window = await until('IntelliSense ready', () => sql.window(doc)?.state === 'connected' && sql.window(doc));
    assert.strictEqual(window.summary.database, 'ShooterSql');
    const tables = await until('tables listed', async () => {
      const l = await labels(doc, new vscode.Position(0, 'SELECT * FROM dbo.'.length));
      return l.includes('Ludzie') && l;
    }, 30000);
    assert.ok(tables.includes('Ludzie'), tables.join(', '));
    const columns = await labels(doc, new vscode.Position(2, 'SELECT L.'.length));
    assert.ok(['Id', 'Imie', 'Nazwisko'].every((c) => columns.includes(c)), columns.slice(0, 20).join(', '));
  });

  await check('another database is picked as from Available Databases; its objects come with it', async () => {
    await sql.changeDatabase('master');
    const window = await until('IntelliSense ready again', () => sql.window(doc)?.state === 'connected' && sql.window(doc));
    assert.strictEqual(window.summary.database, 'master');
    const tables = await labels(doc, new vscode.Position(0, 'SELECT * FROM dbo.'.length));
    assert.ok(!tables.includes('Ludzie'), 'Ludzie still offered in master');
  });

  await check('a new query window connects to the last connection by itself', async () => {
    await vscode.commands.executeCommand('csharpShooter.sql.newQuery');
    const untitled = vscode.window.activeTextEditor.document;
    assert.strictEqual(untitled.languageId, 'sql');
    const window = await until('new window connected', () => sql.window(untitled)?.state === 'connected' && sql.window(untitled), 60000);
    assert.strictEqual(window.summary.database, 'ShooterSql');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check('a syntax error is underlined', async () => {
    const wrong = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELEC * FROM dbo.Ludzie' });
    await vscode.window.showTextDocument(wrong);
    const errors = await until('diagnostics', () => vscode.languages.getDiagnostics(wrong.uri).length && vscode.languages.getDiagnostics(wrong.uri), 60000);
    assert.strictEqual(errors[0].severity, vscode.DiagnosticSeverity.Error);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check('Disconnect leaves the window not connected', async () => {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('csharpShooter.sql.disconnect');
    assert.strictEqual(sql.window(doc), undefined);
  });

  await check('a wrong server is said in an error, and the window stays not connected', async () => {
    const outcome = await sql.connect(doc, { connectionString: 'Data Source=np:\\\\.\\pipe\\no-such-server\\tsql\\query; Integrated Security=True; Connect Timeout=3; Encrypt=False' });
    assert.ok(outcome.error, JSON.stringify(outcome));
    assert.strictEqual(sql.window(doc), undefined);
  });

  // SSMS's Connect dialog: what the page is sent, and its messages given to the extension as the page sends them.
  const posted = (dialog, type) => dialog.posted.filter((m) => m.type === type).at(-1);
  let dialog;
  let local;

  await check("Połącz opens SSMS's Connect dialog: SSMS's recent connections, the solution's strings, this machine's servers", async () => {
    await vscode.window.showTextDocument(doc);
    vscode.commands.executeCommand('csharpShooter.sql.connect');
    dialog = await until('dialog', () => sql.dialog());
    await dialog.receive({ type: 'ready' });
    const lists = posted(dialog, 'entries');
    local = lists.solution.find((e) => e.key === 'app:appsettings.json#Local');
    assert.ok(local, JSON.stringify(lists.solution));
    assert.ok(lists.local.some((e) => /^\(localdb\)\\/i.test(e.fields.server)), JSON.stringify(lists.local.map((e) => e.label)));
    // SSMS 21/22's history (RegSrvr17.xml) where SSMS is installed: each as "server, database (login)", no password in it
    const fromSsms = lists.history.filter((e) => e.origin === 'ssms');
    console.log(`     SSMS's recent connections: ${fromSsms.length}`);
    assert.ok(fromSsms.every((e) => /^[^,]+, .+ \(.*\)$/.test(e.label) && !JSON.stringify(e).toLowerCase().includes('password=')), JSON.stringify(fromSsms[0]));
  });

  await check('an entry fills the Connection Properties; the Connection String tab hides the password', async () => {
    await dialog.receive({ type: 'select', key: local.key });
    const { fields } = posted(dialog, 'fields');
    assert.strictEqual(fields.database, 'ShooterSql');
    assert.strictEqual(fields.authentication, 'Integrated');
    await dialog.receive({ type: 'preview', fields: { ...fields, authentication: 'SqlLogin', user: 'sa' }, password: 'tajne', key: local.key });
    const { text } = posted(dialog, 'preview');
    assert.ok(/password=\*{8}/i.test(text) && !text.includes('tajne') && /application name=CSharpShooter/i.test(text), text);
  });

  await check("Database Name lists the server's databases", async () => {
    const { fields } = posted(dialog, 'fields');
    await dialog.receive({ type: 'databases', fields, password: '', key: local.key });
    const { names } = posted(dialog, 'databases');
    assert.ok(names.includes('ShooterSql') && names.includes('master'), JSON.stringify(names));
  });

  await check('Połącz connects the query window and closes the dialog', async () => {
    const { fields } = posted(dialog, 'fields');
    await dialog.receive({ type: 'connect', fields, password: '', key: local.key, remember: false });
    assert.strictEqual(await dialog.result, true);
    const window = await until('connected', () => sql.window(doc)?.state === 'connected' && sql.window(doc));
    assert.strictEqual(window.summary.database, 'ShooterSql');
  });

  await check('a server typed in the dialog connects and comes first in the history next time', async () => {
    const { fields } = posted(dialog, 'fields');
    vscode.commands.executeCommand('csharpShooter.sql.connect');
    dialog = await until('second dialog', () => sql.dialog() !== dialog && sql.dialog());
    await dialog.receive({ type: 'connect', fields: { ...fields, database: 'master', encrypt: 'Optional' }, password: '', key: null, remember: false });
    assert.strictEqual(await dialog.result, true);
    await until('connected to master', () => sql.window(doc)?.summary.database === 'master');
    vscode.commands.executeCommand('csharpShooter.sql.connect');
    dialog = await until('third dialog', () => sql.dialog() !== dialog && sql.dialog());
    await dialog.receive({ type: 'ready' });
    const first = posted(dialog, 'entries').history[0];
    assert.ok(first.origin === 'recent' && first.fields.database === 'master' && first.label.endsWith(')'), JSON.stringify(first));
    await dialog.receive({ type: 'remove', key: first.key });
    assert.ok(!posted(dialog, 'entries').history.some((e) => e.key === first.key));
    await dialog.receive({ type: 'cancel' });
    assert.strictEqual(await dialog.result, false);
  });

  const localString = (await sql.solutionConnections())[0].connectionString;

  await check('Wykonaj (Ctrl+Shift+E, F5) runs the window: rows in Wyniki, PRINT in Komunikaty, the status line', async () => {
    const run = await sql.newQuery(localString, "IF NOT EXISTS (SELECT * FROM dbo.Ludzie) INSERT dbo.Ludzie VALUES (1, N'Jan', N'Kowalski'), (2, N'Anna', NULL);\nSELECT Id, Imie, Nazwisko FROM dbo.Ludzie ORDER BY Id;\nPRINT 'gotowe';", true);
    assert.strictEqual(run.status, 'done');
    assert.ok(!run.hasError, JSON.stringify(run.messages));
    const set = run.sets.at(-1);
    assert.deepStrictEqual(set.columns, ['Id', 'Imie', 'Nazwisko']);
    assert.strictEqual(set.rows[0][1].displayValue, 'Jan');
    assert.strictEqual(set.rows[1][2].isNull, true);
    assert.ok(run.messages.some((m) => m.text === 'gotowe'), JSON.stringify(run.messages));
    assert.ok(/^\d\d:\d\d:\d\d$/.test(run.elapsed) && run.summary.database === 'ShooterSql', JSON.stringify(run.summary));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check("an error is said in Komunikaty with its line in the window; the selection alone runs", async () => {
    const window = await sql.newQuery(localString, "SELECT 1 AS a;\n\nSELECT 1/0;\nSELECT 'wybrane' AS b;", false);
    const editor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('csharpShooter.sql.execute');
    let run = sql.results.run(editor.document);
    assert.ok(run.hasError, JSON.stringify(run.messages));
    assert.strictEqual(run.messages.find((m) => m.isError).line, 2);
    editor.selection = new vscode.Selection(3, 0, 3, 100);
    await vscode.commands.executeCommand('csharpShooter.sql.execute');
    run = sql.results.run(editor.document);
    assert.ok(!run.hasError && run.sets.length === 1 && run.sets[0].rows[0][0].displayValue === 'wybrane', JSON.stringify(run.sets));
    assert.ok(window);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check("the status bar is VS's query status: state, server (version), login (SPID), database, time, rows", async () => {
    await sql.newQuery(localString, 'SELECT name FROM sys.databases;', true);
    const { items } = sql;
    await until('SPID', () => /\(\d+\)$/.test(items.user.text), 20000);
    assert.ok(items.state.text.includes('Zapytanie zostało wykonane pomyślnie.'), items.state.text);
    assert.ok(/ \(\d+\.\d+ \w+\)$/.test(items.server.text), items.server.text);
    assert.ok(items.database.text.endsWith('ShooterSql'), items.database.text);
    assert.ok(/^\d\d:\d\d:\d\d$/.test(items.time.text) && /^\d+ wiersz/.test(items.rows.text), `${items.time.text} ${items.rows.text}`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check("VS's toolbar above the first line: Wykonaj, Analizuj, the connection, the database as a drop-down", async () => {
    await sql.newQuery(localString, 'SELECT 1;', false);
    const doc = vscode.window.activeTextEditor.document;
    const lenses = await until('lenses', async () => {
      const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
      return l?.length >= 4 && l;
    }, 20000);
    const titles = lenses.map((l) => l.command.title);
    assert.ok(titles[0].includes('Wykonaj') && titles[1].includes('Analizuj') && /\$\(database\) ShooterSql \$\(chevron-down\)/.test(titles[3]), titles.join(' | '));
    assert.strictEqual(lenses[3].command.command, 'csharpShooter.sql.changeDatabase');
    assert.ok(lenses.every((l) => l.range.start.line === 0));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check('Analizuj (Ctrl+F5) checks the window without running it: an error with its line, no rows', async () => {
    await sql.newQuery(localString, "SELECT 1 AS a;\nSELEC 2;", false);
    const doc = vscode.window.activeTextEditor.document;
    const run = await vscode.commands.executeCommand('csharpShooter.sql.parse');
    assert.ok(run.hasError && run.sets.length === 0, JSON.stringify(run));
    assert.strictEqual(run.messages.find((m) => m.isError).line, 1);
    const fix = new vscode.WorkspaceEdit();
    fix.replace(doc.uri, new vscode.Range(1, 0, 1, 8), 'SELECT 2;');
    await vscode.workspace.applyEdit(fix);
    const ok = await vscode.commands.executeCommand('csharpShooter.sql.parse');
    assert.ok(!ok.hasError && ok.sets.length === 0, JSON.stringify(ok.messages));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check("the SQL editor page (vsc-ms-sql-manager's): Monaco loads, runs, lists databases, has the service's IntelliSense", async () => {
    const uri = vscode.Uri.file(path.join(root, 'page.sql'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from('SELECT * FROM dbo.'));
    await vscode.commands.executeCommand('vscode.openWith', uri, 'csharpShooter.sqlEditor');
    const doc = await vscode.workspace.openTextDocument(uri);
    const page = await until('page', () => sql.editors().page(doc), 20000);
    await until('Monaco', () => page.monacoReady || page.errors.length, 60000);
    assert.deepStrictEqual(page.errors, []);
    // it took the workspace's last connection as it opened; this check's is the solution's
    await until('opened', () => sql.window(doc)?.state === 'connected' || !sql.window(doc), 60000);
    await sql.connect(doc, { connectionString: localString });
    await until('connected', () => sql.window(doc)?.state === 'connected', 60000);
    const state = page.posted.filter((m) => m.type === 'state').at(-1).state;
    assert.ok(state && state.database === 'ShooterSql', JSON.stringify(state));
    await page.receive({ type: 'complete', id: 1, line: 0, character: 'SELECT * FROM dbo.'.length });
    const items = page.posted.find((m) => m.type === 'reply' && m.id === 1).value.items;
    assert.ok(items.some((i) => i.label === 'Ludzie'), items.slice(0, 10).map((i) => i.label).join(', '));
    // as Monaco asks while typing: the page's text and the request right after it, not waiting for the edit
    page.receive({ type: 'edit', text: 'SELECT * FROM dbo.Lu' });
    await page.receive({ type: 'complete', id: 11, line: 0, character: 'SELECT * FROM dbo.Lu'.length });
    const typed = page.posted.find((m) => m.type === 'reply' && m.id === 11).value.items;
    assert.ok(typed.some((i) => i.label === 'Ludzie'), `tables while typing: ${typed.slice(0, 10).map((i) => i.label).join(', ')}`);
    // after FROM, the database's objects come before the keywords (a large database has thousands of them)
    page.receive({ type: 'edit', text: 'SELECT * FROM ' });
    await page.receive({ type: 'complete', id: 13, line: 0, character: 'SELECT * FROM '.length });
    const afterFrom = page.posted.find((m) => m.type === 'reply' && m.id === 13).value.items;
    const ludzie = afterFrom.findIndex((i) => i.label === 'Ludzie');
    const firstKeyword = afterFrom.findIndex((i) => i.kind === 17);
    assert.ok(ludzie >= 0 && (firstKeyword < 0 || ludzie < firstKeyword), afterFrom.slice(0, 8).map((i) => `${i.label}:${i.kind}`).join(', '));
    page.receive({ type: 'edit', text: 'SELECT GETD' });
    await page.receive({ type: 'complete', id: 12, line: 0, character: 'SELECT GETD'.length });
    const functions = page.posted.find((m) => m.type === 'reply' && m.id === 12).value.items;
    assert.ok(functions.some((i) => /^GETDATE/i.test(i.label)), `functions while typing: ${functions.slice(0, 10).map((i) => i.label).join(', ')}`);
    // Monaco's own suggest list, in the page, for a table and a function
    page.post({ type: 'suggestTest', text: 'SELECT * FROM dbo.' });
    const shown = await until('suggest list', () => page.suggestShown, 30000);
    assert.ok(shown.includes('Ludzie'), `Monaco's list: ${shown.join(', ')}`);
    await page.receive({ type: 'databases', id: 2 });
    assert.ok(page.posted.find((m) => m.type === 'reply' && m.id === 2).value.includes('master'));
    await page.receive({ type: 'edit', text: 'SELECT 42 AS odpowiedz;' });
    assert.strictEqual(doc.getText(), 'SELECT 42 AS odpowiedz;');
    await page.receive({ type: 'execute', text: doc.getText(), firstLine: 0 });
    const run = page.posted.filter((m) => m.type === 'run').at(-1).run;
    assert.ok(run.status === 'done' && run.sets[0].rows[0][0].displayValue === '42', JSON.stringify(run));
    await page.receive({ type: 'useDatabase', name: 'master' });
    await until('master', () => sql.window(doc)?.summary.database === 'master', 30000);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.workspace.fs.delete(uri);
  });

  await check("an untitled query in the SQL editor page (New Query's) has the service's tables and functions", async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'csharpShooter.sqlEditor');
    const page = await until('page', () => sql.editors().page(doc), 20000);
    await until('Monaco', () => page.monacoReady || page.errors.length, 60000);
    await until('opened', () => sql.window(doc)?.state === 'connected' || !sql.window(doc), 60000);
    await sql.connect(doc, { connectionString: localString });
    await until('connected', () => sql.window(doc)?.state === 'connected', 60000);
    page.post({ type: 'suggestTest', text: 'SELECT * FROM dbo.' });
    const tables = await until('suggest list', () => page.suggestShown, 30000);
    assert.ok(tables.includes('Ludzie'), `tables: ${tables.join(', ')}`);
    page.suggestShown = undefined;
    page.post({ type: 'suggestTest', text: 'SELECT GETD' });
    const functions = await until('suggest list', () => page.suggestShown, 30000);
    assert.ok(functions.some((l) => /^GETDATE/i.test(l)), `functions: ${functions.join(', ')}`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  await check("the SQL Server Object Explorer has the dialog's server: Bazy danych > ShooterSql > Tabele > dbo.Ludzie > Kolumny", async () => {
    const { provider } = sql.explorer();
    const [root] = await provider.getChildren();
    const servers = await provider.getChildren(root);
    const server = servers.find((s) => /pipe/i.test(s.server.fields.server));
    assert.ok(server, JSON.stringify(servers.map((s) => s.server.fields.server)));
    const top = await provider.getChildren(server);
    assert.deepStrictEqual(top.map((n) => n.info.label), ['Bazy danych', 'Zabezpieczenia', 'Obiekty serwera']);
    assert.ok(/\(SQL Server .* - .+\)$/.test(provider.getTreeItem(server).label), provider.getTreeItem(server).label);
    const db = (await provider.getChildren(top[0])).find((n) => n.info.label === 'ShooterSql');
    const tables = (await provider.getChildren(db)).find((n) => n.info.label === 'Tabele');
    const ludzie = (await provider.getChildren(tables)).find((n) => n.info.label === 'dbo.Ludzie');
    const columns = (await provider.getChildren(ludzie)).find((n) => n.info.label === 'Kolumny');
    const labels = (await provider.getChildren(columns)).map((n) => n.info.label);
    assert.ok(labels[0].startsWith('Id (PK, int'), labels.join(', '));
    assert.strictEqual(sql.explorer().databaseOf(ludzie), 'ShooterSql');
    // SSMS's Filter Settings on Tabele: its properties from the service, OK filters the folder and says so
    const names = async () => (await provider.getChildren(tables)).map((n) => n.info.label);
    vscode.commands.executeCommand('csharpShooter.sqlExplorer.filter', tables);
    const filterDialog = await until('filter dialog', () => sql.explorer().filterDialog(), 10000);
    const page = filterDialog.panel.webview.html;
    assert.ok(page.includes('Nazwa') && page.includes('Schemat') && page.includes('Zawiera') && page.includes('Wyczyść filtr'), 'properties, operators, buttons');
    filterDialog.receive({ type: 'ok', filters: [{ name: 'Name', operator: 8, value: 'xyz' }] });
    await filterDialog.result;
    await until('filtered', async () => !(await names()).includes('dbo.Ludzie'), 20000);
    assert.strictEqual(provider.getTreeItem(tables).label, 'Tabele (przefiltrowane)');
    assert.ok(/ filtered$/.test(provider.getTreeItem(tables).contextValue));
    await sql.explorer().filter(tables, [{ name: 'Name', operator: 8, value: 'Lud' }]);
    assert.ok((await names()).includes('dbo.Ludzie'));
    await vscode.commands.executeCommand('csharpShooter.sqlExplorer.clearFilter', tables);
    assert.strictEqual(provider.getTreeItem(tables).label, 'Tabele');
    assert.ok((await names()).includes('dbo.Ludzie'));
    // Select Top 1000 Rows: SSMS's query, run
    const run = await sql.explorer().selectTop(ludzie);
    const text = vscode.window.activeTextEditor.document.getText();
    assert.ok(/^SELECT TOP \(1000\) \[Id\]\n {6},\[Imie\]\n {6},\[Nazwisko\]\n {2}FROM \[ShooterSql\]\.\[dbo\]\.\[Ludzie\]/.test(text), text);
    assert.ok(run.sets[0].rows.length >= 2, JSON.stringify(run.sets));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
}

module.exports = { run };
