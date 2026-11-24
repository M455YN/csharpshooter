// Entity Framework Core migrations in a real editor on a solution of the test's own: a console app with a SQLite
// DbContext, the EF Core tools in its tool manifest. Add Migration into a folder of its own, Update Database, Generate SQL
// Script, Remove Last Migration, each through its command with the answers a person gives.
//   node test/migrations-suite.js <empty folder>          (makes the solution: Contoso.Data; restores NuGet packages)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/migrations-suite.js node test/runTest.js
const fs = require('fs');
const path = require('path');

const CONTEXT = `using Microsoft.EntityFrameworkCore;

namespace Contoso.Data;

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public class BloggingContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) => options.UseSqlite("Data Source=app.db");
}
`;

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  const run = (...args) => execFileSync('dotnet', args, { cwd: folder, stdio: 'inherit' });
  fs.mkdirSync(folder, { recursive: true });
  run('new', 'sln', '-n', 'Contoso.Data', '--format', 'sln');
  run('new', 'console', '-n', 'Contoso.Data', '-o', 'App');
  run('add', 'App', 'package', 'Microsoft.EntityFrameworkCore.Sqlite', '--version', '10.0.*');
  run('add', 'App', 'package', 'Microsoft.EntityFrameworkCore.Design', '--version', '10.0.*');
  run('sln', 'add', 'App');
  fs.writeFileSync(path.join(folder, 'App', 'BloggingContext.cs'), CONTEXT);
  run('new', 'tool-manifest');
  run('tool', 'install', 'dotnet-ef', '--version', '10.0.*');
  process.exit(0);
}

const vscode = require('vscode');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const lines = [];
  let failed = 0;
  const expect = (name, ok, got) => {
    failed += ok ? 0 : 1;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}`);
  };
  const api = await vscode.extensions.getExtension('M455YN.csharpshooter').activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const app = path.join(root, 'App');
  const project = { file: path.join(app, 'Contoso.Data.csproj') };
  const window = vscode.window;
  const real = { showInputBox: window.showInputBox, showQuickPick: window.showQuickPick, showWarningMessage: window.showWarningMessage };
  const answers = [];
  const said = [];
  window.showInputBox = async () => answers.shift();
  window.showQuickPick = async (items) => { const next = answers.shift(); const list = await items; return typeof next === 'function' ? next(list) : next; };
  window.showWarningMessage = async (message, ...rest) => { said.push(message); const next = answers.shift(); return typeof next === 'function' ? next(rest) : next; };
  const folder = path.join(app, 'Data', 'Migrations');
  const migrationFiles = () => (fs.existsSync(folder) ? fs.readdirSync(folder) : []);
  try {
    expect('the project declares BloggingContext', api.migrations.contextsOf(project.file).join() === 'BloggingContext', api.migrations.contextsOf(project.file).join() || 'none');

    answers.push('Initial', 'Data/Migrations');
    let code = await vscode.commands.executeCommand('csharpShooter.ef.addMigration', project);
    const added = migrationFiles();
    expect('Add Migration: into the folder given', code === 0 && added.some((f) => /_Initial\.cs$/.test(f)) && added.some((f) => /ModelSnapshot\.cs$/.test(f)), `exit ${code}: ${added.join(', ') || 'nothing'}; ${said.join(' | ')}`);

    // The name given; the folder offered (the context's, remembered) taken as it is.
    answers.push('Second');
    let offered;
    window.showInputBox = async (options) => {
      if (options?.value !== undefined) offered = options.value;
      return answers.length ? answers.shift() : options?.value;
    };
    code = await vscode.commands.executeCommand('csharpShooter.ef.addMigration', project);
    expect("the context's folder remembered", offered === 'Data/Migrations' && migrationFiles().some((f) => /_Second\.cs$/.test(f)), `offered ${offered}; exit ${code}`);
    window.showInputBox = async () => answers.shift();

    let listed;
    answers.push((list) => ((listed = list.map((i) => i.label)), list[0]));
    code = await vscode.commands.executeCommand('csharpShooter.ef.updateDatabase', project);
    expect('Update Database: the latest, its migrations listed newest first', code === 0 && fs.existsSync(path.join(app, 'app.db')) && listed?.[1] === 'Second' && listed?.[2] === 'Initial',
      `exit ${code}; listed ${listed?.join(', ')}; app.db ${fs.existsSync(path.join(app, 'app.db'))}`);

    answers.push((list) => list[1]); // from an empty database: SQLite writes no idempotent script
    code = await vscode.commands.executeCommand('csharpShooter.ef.script', project);
    const script = vscode.window.activeTextEditor?.document;
    expect('Generate SQL Script: opened', code === 0 && script?.fileName.endsWith('.sql') && /CREATE TABLE/i.test(script.getText()), `exit ${code}; ${script?.fileName}`);

    answers.push((buttons) => buttons.find((b) => typeof b === 'string'));
    code = await vscode.commands.executeCommand('csharpShooter.ef.removeMigration', project);
    expect('Remove Last Migration: asked first, then removed', code === 0 && !migrationFiles().some((f) => /_Second\.cs$/.test(f)) && migrationFiles().some((f) => /_Initial\.cs$/.test(f)),
      `exit ${code}: ${migrationFiles().join(', ')}; asked: ${said.at(-1)}`);

    const env = await vscode.commands.executeCommand('csharpShooter.ef.environment', 'Staging');
    expect('the environment chosen is kept', env === 'Staging' && api.migrations.environment() === 'Staging', api.migrations.environment());
    await vscode.commands.executeCommand('csharpShooter.ef.environment', 'Development');
  } finally {
    Object.assign(window, real);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(path.join(app, 'Data'), { recursive: true, force: true });
    fs.rmSync(path.join(app, 'app.db'), { force: true });
    console.log(lines.join('\n'));
  }
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
