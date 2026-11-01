// Add New Item and Add Class in the Solution Explorer, in a real editor on the web app test/hot-reload-suite.js makes:
// the list as VS 2026 shows it, then every item made, each C# one built. The app's files are put back afterwards.
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/new-item-suite.js node test/runTest.js
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
  const api = await vscode.extensions.getExtension('M455YN.csharpshooter').activate();
  await api.whenReady();
  for (let i = 0; i < 600 && api.loading() && !api.loading().done; i++) await sleep(500);
  const app = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'WebApp');
  const at = (...p) => path.join(app, ...p);
  const read = (...p) => (fs.existsSync(at(...p)) ? fs.readFileSync(at(...p), 'utf8') : '');
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-new-'));
  fs.cpSync(app, backup, { recursive: true, filter: (p) => !/[\\/](bin|obj)$/.test(p) });

  const window = vscode.window;
  const real = { showInputBox: window.showInputBox, showQuickPick: window.showQuickPick, showErrorMessage: window.showErrorMessage };
  const said = [];
  window.showErrorMessage = async (m) => void said.push(m);
  const { solutionView } = api;
  const item = async (...p) => {
    for (let i = 0; i < 40; i++) {
      const found = await solutionView.findItem(at(...p));
      if (found) return found;
      await sleep(250);
    }
    throw new Error(`${at(...p)} is not in the Solution Explorer`);
  };
  const add = async (where, choice) => vscode.commands.executeCommand('csharpShooter.solution.addNewItem', where, choice);

  try {
    // The list, as VS's: its order and Polish, then the name box with VS's default.
    let list;
    let picked;
    let box;
    window.showQuickPick = async (items, options) => ((list = await items), (picked = options), (await items)[0]);
    window.showInputBox = async (options) => ((box = options), 'Pierwsza');
    await add(await item('Pages'));
    expect('the list in VS\'s order and words', list[0].label === 'Klasa' && list[0].detail === 'Pusta deklaracja klasy' && list[3].label === 'Kontroler MVC — pusty' && list[7].label === 'Strona Razor — pusta' && list.length === 38,
      `${list.length}: ${list.slice(0, 4).map((i) => i.label).join(', ')}…; title "${picked.title}"`);
    expect('the name box has VS\'s default, and the extension is added to a bare name', box.value === 'Class.cs' && /class Pierwsza/.test(read('Pages', 'Pierwsza.cs')) && /namespace WebApp\.Pages/.test(read('Pages', 'Pierwsza.cs')),
      `box "${box.value}"; ${/namespace [^;\r\n]*/.exec(read('Pages', 'Pierwsza.cs'))?.[0]}`);
    window.showQuickPick = real.showQuickPick;

    // A taken default gets a number, as VS's.
    fs.writeFileSync(at('Class.cs'), '// taken\n');
    window.showInputBox = async (options) => ((box = options), undefined);
    await add({ kind: 'project', file: at('WebApp.csproj') }, { item: 'Class' });
    expect('a taken default gets a number', box.value === 'Class1.cs', box.value);
    fs.rmSync(at('Class.cs'));

    // Add Class goes straight to the name.
    await vscode.commands.executeCommand('csharpShooter.solution.addClass', await item('Pages'), 'Druga');
    expect('Add Class', /class Druga/.test(read('Pages', 'Druga.cs')), 'Pages/Druga.cs');

    // Every item of the list made, in a folder of its own.
    fs.mkdirSync(at('Made'));
    const folder = await item('Made');
    const { ITEMS } = require(path.join(process.env.CSHARPSHOOTER_SOURCES, 'new-item.js'));
    const missing = [];
    for (const [english, , defaultName, , how] of ITEMS) {
      const ext = path.extname(defaultName);
      const name = how.fixedName ? undefined : `${english.replace(/[^A-Za-z]/g, '')}${/Controller/.test(defaultName) ? 'Controller' : ''}${ext}`;
      const made = await add(folder, { item: english, name });
      if (!made || !fs.existsSync(made)) missing.push(english);
    }
    expect('every item is made', !missing.length, missing.length ? `not made: ${missing.join(', ')}; said: ${said.slice(-2).join(' | ')}` : `${ITEMS.length} items`);
    expect('dotnet new made them for the folder: page, controller with actions', fs.existsSync(at('Made', 'RazorPageEmpty.cshtml.cs')) && /namespace WebApp\.Made/.test(read('Made', 'RazorPageEmpty.cshtml.cs'))
      && /HttpPost/.test(read('Made', 'MVCControllerwithreadwriteactionsController.cs')) && !/HttpPost/.test(read('Made', 'MVCControllerEmptyController.cs')),
    fs.readdirSync(at('Made')).filter((f) => /Razor|MVC/.test(f)).slice(0, 5).join(', '));

    // What they made builds (Startup's and the others' usings included).
    const built = await new Promise((resolve) => require('child_process').execFile('dotnet', ['build', app, '-nologo', '-v', 'q'], { cwd: app, maxBuffer: 1 << 24 },
      (e, out) => resolve({ ok: !e, out: [...new Set(String(out).split(/\r?\n/).filter((l) => /error/.test(l)).map((l) => l.replace(/ \[.*$/, '').replace(/^.*[\\/]/, '')))].slice(0, 5).join(' | ') })));
    expect('the project builds with them', built.ok, built.ok ? 'built' : built.out);
  } finally {
    Object.assign(window, real);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (/^(bin|obj)$/.test(e.name) ? []
      : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk(app)) if (!fs.existsSync(path.join(backup, path.relative(app, f)))) fs.rmSync(f);
    fs.rmSync(at('Made'), { recursive: true, force: true });
    fs.cpSync(backup, app, { recursive: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
