// CSharpShooter and CSharpShooter SQL side by side, no SQL Server needed: a .sql file is the SQL extension's (its editor
// page, its commands), and CSharpShooter itself contributes nothing of SQL's. Any workspace; a .sql file of the test's own.
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
  expect('two extensions: CSharpShooter with no SQL of its own, CSharpShooter SQL with it', !!main && !!sql
    && !contributed(main).some((c) => /\.sql\./.test(c)) && contributed(sql).includes('csharpShooter.sql.execute') && !main.packageJSON.contributes.customEditors,
    `CSharpShooter: ${contributed(main).filter((c) => /sql/i.test(c)).join(', ') || 'no SQL commands'}; SQL: ${contributed(sql).length} commands`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-sql-'));
  const file = path.join(dir, 'query.sql');
  fs.writeFileSync(file, 'SELECT 1;\n');
  try {
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'csharpShooter.sqlEditor');
    for (let i = 0; i < 40 && !sql.isActive; i++) await sleep(250);
    await sleep(1000);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    expect('a .sql file opens in CSharpShooter SQL\'s editor page, the extension active', sql.isActive && tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === 'csharpShooter.sqlEditor',
      `active ${sql.isActive}, tab ${tab?.label} (${tab?.input?.viewType})`);
    // Monaco in the page, with only its SQL language left of the ones it ships (scripts/fetch-monaco.js).
    const editors = sql.exports.sql.editors();
    let page;
    for (let i = 0; i < 80 && !(page = editors.page({ uri: vscode.Uri.file(file) }))?.monacoReady; i++) await sleep(250);
    expect('the page\'s Monaco editor is ready', !!page?.monacoReady, `monacoReady ${page?.monacoReady}`);
    const commands = await vscode.commands.getCommands(true);
    expect('its commands are there (Wykonaj, Połącz, Eksplorator obiektów)', ['csharpShooter.sql.execute', 'csharpShooter.sql.connect'].every((c) => commands.includes(c)),
      commands.filter((c) => c.startsWith('csharpShooter.sql.')).length + ' csharpShooter.sql.* commands');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
