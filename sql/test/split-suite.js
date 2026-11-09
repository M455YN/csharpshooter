// CSharpShooter and CSharpShooter SQL side by side, no SQL Server needed: CSharpShooter contributes nothing of SQL's, and a
// .sql file in VS Code's own editor gets the SQL Tools Service's syntax errors and IntelliSense; checkQuery gives the
// errors of SQL in code. Any workspace; a .sql file of the test's own.
//   EDITOR_EXE=<editor exe> WORKSPACE=<any folder> SUITE=sql/test/split-suite.js node test/runTest.js
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const lines = [];
  let failed = 0;
  const expect = (name, ok, got) => {
    failed += ok ? 0 : 1;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}`);
  };
  const main = vscode.extensions.getExtension('M455YN.csharpshooter');
  const sql = vscode.extensions.getExtension('M455YN.csharpshooter-sql');
  const contributed = (ext) => (ext?.packageJSON.contributes.commands || []).map((c) => c.command);
  expect('two extensions: CSharpShooter with no SQL of its own, CSharpShooter SQL its add-on (checkQuery, openInSsms)', !!main && !!sql
    && !contributed(main).some((c) => /\.sql\./.test(c)) && contributed(sql).join() === 'csharpShooter.sql.checkQuery,csharpShooter.sql.openInSsms'
    && sql.packageJSON.extensionDependencies?.join() === 'M455YN.csharpshooter' && !sql.packageJSON.contributes.customEditors,
    `CSharpShooter: ${contributed(main).filter((c) => /sql/i.test(c)).join(', ') || 'no SQL commands'}; SQL: ${contributed(sql).join(', ')}; needs ${sql?.packageJSON.extensionDependencies}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-sql-'));
  const file = path.join(dir, 'query.sql');
  fs.writeFileSync(file, 'SELECT e.Id\nFROM Employees e\nWHER e.Id = 1\n');
  try {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    for (let i = 0; i < 40 && !sql.isActive; i++) await sleep(250);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    expect('a .sql file opens in VS Code\'s text editor, the extension active', sql.isActive && tab?.input instanceof vscode.TabInputText,
      `active ${sql.isActive}, tab ${tab?.label}`);
    let errors = [];
    for (let i = 0; i < 120 && !errors.length; i++, await sleep(500)) errors = vscode.languages.getDiagnostics(doc.uri);
    expect('its syntax error is underlined on its line, with no connection', errors.some((d) => d.range.start.line === 2 && /WHER/i.test(d.message)),
      errors.map((d) => `${d.range.start.line}:${d.range.start.character} ${d.message}`).join('; ') || 'none');
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(1, 0));
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label).toUpperCase());
    expect('IntelliSense offers T-SQL keywords', ['SELECT', 'WHERE'].every((k) => labels.includes(k)), `${labels.length} items: ${labels.slice(0, 8).join(', ')}`);
    const found = await vscode.commands.executeCommand('csharpShooter.sql.checkQuery', 'declare @a int = 1\nselect e.Id from Employees e\nwher e.Id = @a\n');
    expect('checkQuery gives the error of SQL in code, by line and column', found.length > 0 && found[0].line === 2 && typeof found[0].character === 'number' && /wher/i.test(found[0].message),
      JSON.stringify(found));
    const two = await vscode.commands.executeCommand('csharpShooter.sql.checkQuery', 'select a\nfrom t spt\nwherse spt.ActiveP = 1\nordser by spt.SortOrder\n');
    const echo = await vscode.commands.executeCommand('csharpShooter.sql.checkQuery', 'select a\nfrom t\nwher a in (\n  1,\n  2)\norder by a\n');
    expect('checkQuery finds a mistyped clause word after another in one statement, and no echo of its own',
      two.map((e) => e.line).join() === '2,3' && echo.every((e) => e.line <= 3),
      `${two.map((e) => `${e.line}: ${e.message}`).join('; ')} / ${echo.length} for the IN list`);
    const clean = await vscode.commands.executeCommand('csharpShooter.sql.checkQuery', 'select 1');
    expect('checkQuery finds none in a correct query', clean.length === 0, JSON.stringify(clean));
    const t = Date.now();
    const several = await Promise.all(['select a from t\nwher a = 1', 'select b frm t2', 'select c from t4 where c = (1'].map((q) =>
      vscode.commands.executeCommand('csharpShooter.sql.checkQuery', q)));
    const ms = Date.now() - t;
    expect('checkQuery answers three queries at once, each its own errors, in well under the service\'s 750 ms', ms < 200 && several.every((e) => e.length > 0),
      `${ms} ms, ${several.map((e) => e.length).join('/')} errors`);
    // A Razor page, C# Razor Tag Helper Support not installed: CSharpShooter SQL's own lens and checks.
    const page = path.join(dir, 'Index.cshtml');
    fs.writeFileSync(page, '<grid id="g"\n      select=@(@"\nselect e.Id\nfrom Employees e\nwherse e.Name = ""x""\nordser by e.Id\n") />\n');
    const pageDoc = await vscode.workspace.openTextDocument(page);
    await vscode.window.showTextDocument(pageDoc);
    let marks = [];
    for (let i = 0; i < 40 && marks.length < 2; i++, await sleep(250)) marks = vscode.languages.getDiagnostics(pageDoc.uri).filter((d) => d.source === 'SQL (grid select)');
    expect('a Tag Helper\'s SQL in a .cshtml has its errors underlined where they are in the page', marks.length === 2
      && pageDoc.getText(marks[0].range) === 'wherse' && pageDoc.getText(marks[1].range) === 'ordser',
      marks.map((d) => `${d.range.start.line}:${d.range.start.character} "${pageDoc.getText(d.range)}" ${d.message}`).join('; ') || 'none');
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', pageDoc.uri);
    const ssms = (lenses || []).filter((l) => l.command?.command === 'csharpShooter.sql.openInSsms');
    const query = ssms[0]?.command.arguments[0];
    expect('Otwórz select w SQL Server Management Studio above it, the query runnable with its DECLARE header',
      ssms.length === 1 && ssms[0].range.start.line === 1 && /Otwórz select w SQL Server Management Studio/.test(ssms[0].command.title)
      && /^-- Wartości przekazywane przez aplikację/.test(query.text) === false && /= "x"/.test(query.text) && query.name === 'grid-select',
      `${ssms.map((l) => `${l.range.start.line}: ${l.command.title}`).join('; ')} / ${JSON.stringify(query?.text.slice(0, 60))}`);
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
