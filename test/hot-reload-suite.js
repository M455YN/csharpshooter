// Hot Reload under the debugger, in a real editor on a small web app of the test's own: a method body and a .cshtml edited
// and saved while the app runs reach it without a restart; an edit the runtime cannot take is reported, not applied.
//   node test/hot-reload-suite.js <empty folder>        (makes the app: dotnet new webapp, a /value endpoint)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/hot-reload-suite.js node test/runTest.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const URL = 'http://127.0.0.1:5197';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  execFileSync('dotnet', ['new', 'webapp', '-n', 'WebApp', '-o', path.join(folder, 'WebApp')], { stdio: 'inherit' });
  execFileSync('dotnet', ['new', 'sln', '-n', 'WebApp', '-o', folder], { stdio: 'inherit' });
  execFileSync('dotnet', ['sln', path.join(folder, fs.readdirSync(folder).find((f) => /\.slnx?$/.test(f))), 'add', path.join(folder, 'WebApp', 'WebApp.csproj')], { stdio: 'inherit' });
  fs.writeFileSync(path.join(folder, 'WebApp', 'Values.cs'), 'namespace WebApp;\n\npublic static class Values\n{\n    public static string Text()\n    {\n        return "one";\n    }\n}\n');
  const program = path.join(folder, 'WebApp', 'Program.cs');
  fs.writeFileSync(program, fs.readFileSync(program, 'utf8').replace('app.MapRazorPages()', 'app.MapGet("/value", () => WebApp.Values.Text());\napp.MapRazorPages()'));
  process.exit(0);
}

const vscode = require('vscode');

const get = (url) => new Promise((resolve) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve(body));
  }).on('error', () => resolve(undefined));
});

async function replaceAndSave(file, from, to) {
  const doc = await vscode.workspace.openTextDocument(file);
  const at = doc.getText().indexOf(from);
  if (at < 0) throw new Error(`${from} is not in ${file}`);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + from.length)), to);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

async function run() {
  const lines = [];
  let failed = 0;
  const expect = (name, ok, got) => {
    failed += ok ? 0 : 1;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}`);
  };
  const ext = vscode.extensions.getExtension('M455YN.csharpshooter');
  const api = await ext.activate();
  await api.whenReady();
  for (let i = 0; i < 600 && api.loading() && !api.loading().done; i++) await sleep(500);
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const values = path.join(root, 'WebApp', 'Values.cs');
  const page = path.join(root, 'WebApp', 'Pages', 'Index.cshtml');
  const valuesBefore = fs.readFileSync(values);
  const pageBefore = fs.readFileSync(page);
  const applied = () => new Promise((r) => {
    const d = api.hotReload.applied.event((o) => (d.dispose(), r(o)));
    setTimeout(() => (d.dispose(), r({ result: 'timeout', said: 'no outcome in 60 s' })), 60000);
  });
  try {
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
      type: 'csharpshooter', request: 'launch', name: 'WebApp', project: path.join(root, 'WebApp', 'WebApp.csproj'),
      startupProject: false, launchBrowser: false, env: { ASPNETCORE_URLS: URL },
    });
    let body;
    for (let i = 0; i < 120 && !(body = await get(`${URL}/value`)); i++) await sleep(500);
    const session = vscode.debug.activeDebugSession;
    expect('the app runs under the debugger with Hot Reload on', body === 'one' && session?.configuration.hotReload === true,
      `/value ${body}, hotReload ${session?.configuration.hotReload}`);

    let outcome = applied();
    await replaceAndSave(values, '"one"', '"two"');
    outcome = await outcome;
    body = await get(`${URL}/value`);
    expect('a method body changed and saved runs at once', outcome.result === 'applied' && body === 'two', `${outcome.result}: ${outcome.said}; /value ${body}`);

    outcome = applied();
    await replaceAndSave(page, 'Welcome', 'Witaj');
    outcome = await outcome;
    body = await get(`${URL}/`);
    expect('a .cshtml line changed and saved is in the next response', outcome.result === 'applied' && /Witaj/.test(body || ''), `${outcome.result}: ${outcome.said}; page has Witaj: ${/Witaj/.test(body || '')}`);

    outcome = applied();
    await replaceAndSave(values, 'public static string Text()', 'public static string Text(int times = 1)');
    outcome = await outcome;
    body = await get(`${URL}/value`);
    expect('an edit the runtime cannot take is reported, not applied', ['restart', 'errors'].includes(outcome.result) && body === 'two',
      `${outcome.result}: ${outcome.said}; /value ${body}`);
    const shown = vscode.languages.getDiagnostics(vscode.Uri.file(values)).filter((d) => d.source === 'Hot Reload');
    expect('it is in Problems', shown.length > 0 || outcome.result === 'errors', shown.map((d) => `${d.code} ${d.message}`).join('; ') || 'none');
  } finally {
    await vscode.debug.stopDebugging();
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(values, valuesBefore);
    fs.writeFileSync(page, pageBefore);
  }
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
