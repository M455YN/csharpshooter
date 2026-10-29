// The Solution Explorer's Rename, Delete, Cut, Copy, Paste and drag and drop, in a real editor on the web app
// test/hot-reload-suite.js makes (WebApp: Values.cs, Pages/Privacy.cshtml with its .cshtml.cs), answering VS Code's boxes
// as a person would. The app's files are put back as they were afterwards.
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/solution-edit-suite.js node test/runTest.js
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
  // The app as it was, without bin and obj, to put back.
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-edit-'));
  fs.cpSync(app, backup, { recursive: true, filter: (p) => !/[\\/](bin|obj)$/.test(p) });

  const window = vscode.window;
  const real = { showInputBox: window.showInputBox, showWarningMessage: window.showWarningMessage, showInformationMessage: window.showInformationMessage };
  const answers = [];
  const said = [];
  window.showInputBox = async () => answers.shift();
  // A modal question gets the next answer; a message that asks nothing is kept for the report.
  const ask = async (message, ...rest) => {
    said.push(message);
    return rest[0]?.modal ? answers.shift() : undefined;
  };
  window.showWarningMessage = ask;
  window.showInformationMessage = ask;
  const { solutionView } = api;
  const item = async (...p) => {
    for (let i = 0; i < 40; i++) {
      const found = await solutionView.findItem(at(...p));
      if (found) return found;
      await sleep(250);
    }
    throw new Error(`${at(...p)} is not in the Solution Explorer`);
  };
  const settle = () => sleep(1500); // the tree reads the disk again 500 ms after a change

  try {
    // Rename a .cs file, its class with it when asked (Yes); Program.cs, in no tab, saved.
    answers.push('Numbers.cs', 'Tak');
    await vscode.commands.executeCommand('csharpShooter.solution.rename', await item('Values.cs'));
    await settle();
    expect('Rename Values.cs, its class renamed when asked', fs.existsSync(at('Numbers.cs')) && !fs.existsSync(at('Values.cs'))
      && /class Numbers/.test(read('Numbers.cs')) && /WebApp\.Numbers\.Text\(\)/.test(read('Program.cs')),
    `Numbers.cs ${fs.existsSync(at('Numbers.cs'))}; Program.cs calls ${/WebApp\.\w+\.Text/.exec(read('Program.cs'))?.[0]}; asked: ${said.filter((s) => /odwołań|references/.test(s)).length}`);

    // Rename a Razor page: its nested .cshtml.cs follows.
    answers.push('Policy.cshtml');
    await vscode.commands.executeCommand('csharpShooter.solution.rename', await item('Pages', 'Privacy.cshtml'));
    await settle();
    expect('Rename Privacy.cshtml, Privacy.cshtml.cs follows', fs.existsSync(at('Pages', 'Policy.cshtml')) && fs.existsSync(at('Pages', 'Policy.cshtml.cs')) && !fs.existsSync(at('Pages', 'Privacy.cshtml.cs')),
      fs.readdirSync(at('Pages')).filter((f) => /^(Policy|Privacy)/.test(f)).join(', '));

    // Copy and Paste beside the original: named as VS names a copy.
    await vscode.commands.executeCommand('csharpShooter.solution.copy', await item('Numbers.cs'));
    await vscode.commands.executeCommand('csharpShooter.solution.paste', await item('Numbers.cs'));
    await settle();
    expect('Copy, Paste beside it: "Numbers - kopiować.cs", as VS 2026 in Polish names it', fs.existsSync(at('Numbers - kopiować.cs')),
      fs.readdirSync(app).filter((f) => /^Numbers/.test(f)).join(', '));

    // Cut and Paste into a folder: a move.
    await vscode.commands.executeCommand('csharpShooter.solution.cut', await item('Numbers - kopiować.cs'));
    await vscode.commands.executeCommand('csharpShooter.solution.paste', await item('Pages'));
    await settle();
    expect('Cut, Paste into Pages: moved', fs.existsSync(at('Pages', 'Numbers - kopiować.cs')) && !fs.existsSync(at('Numbers - kopiować.cs')), fs.readdirSync(at('Pages')).filter((f) => /Numbers/.test(f)).join(', '));

    // A move onto the folder it is in is refused with VS's words.
    said.length = 0;
    await vscode.commands.executeCommand('csharpShooter.solution.cut', await item('Pages', 'Numbers - kopiować.cs'));
    await vscode.commands.executeCommand('csharpShooter.solution.paste', await item('Pages'));
    expect('a move into its own folder refused, as VS', said.some((s) => /Folder docelowy jest taki sam|same as the source/.test(s)), said.join(' | ') || 'nothing said');

    // Drag and drop within the tree: a move; a file dropped from outside: copied in.
    const { editing } = solutionView;
    let data = new vscode.DataTransfer();
    editing.dragAndDrop.handleDrag([await item('Pages', 'Numbers - kopiować.cs')], data);
    await editing.dragAndDrop.handleDrop(await item('wwwroot'), data);
    const outside = path.join(backup, '..', `outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'dropped');
    data = new vscode.DataTransfer();
    data.set('text/uri-list', new vscode.DataTransferItem(vscode.Uri.file(outside).toString()));
    await editing.dragAndDrop.handleDrop(await item('Pages'), data);
    await settle();
    expect('drag within the tree moves, a drop from outside copies in', fs.existsSync(at('wwwroot', 'Numbers - kopiować.cs')) && !fs.existsSync(at('Pages', 'Numbers - kopiować.cs'))
      && fs.existsSync(at('Pages', path.basename(outside))) && fs.existsSync(outside),
    `wwwroot has it ${fs.existsSync(at('wwwroot', 'Numbers - kopiować.cs'))}; dropped file in Pages ${fs.existsSync(at('Pages', path.basename(outside)))}`);
    fs.rmSync(outside, { force: true });

    // Delete, after VS's question (OK): into the Recycle Bin.
    said.length = 0;
    answers.push('OK');
    await vscode.commands.executeCommand('csharpShooter.solution.delete', await item('wwwroot', 'Numbers - kopiować.cs'));
    await settle();
    expect('Delete after VS\'s question', !fs.existsSync(at('wwwroot', 'Numbers - kopiować.cs')) && said.some((s) => /zostanie usunięty|will be deleted/.test(s)), said.join(' | '));

    // Cancelled: nothing deleted.
    answers.push(undefined);
    await vscode.commands.executeCommand('csharpShooter.solution.delete', await item('Pages', path.basename(outside)));
    expect('Delete cancelled leaves it', fs.existsSync(at('Pages', path.basename(outside))), 'kept');
  } finally {
    Object.assign(window, real);
    await vscode.workspace.saveAll();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // The app's files put back: those made removed, the rest as they were.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (/^(bin|obj)$/.test(e.name) ? []
      : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk(app)) if (!fs.existsSync(path.join(backup, path.relative(app, f)))) fs.rmSync(f);
    fs.cpSync(backup, app, { recursive: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
