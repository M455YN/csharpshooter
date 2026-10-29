// The refactorings that ask their options, in a real editor on a small project of the test's own: each run through its
// command with the answers a person would give VS Code's input boxes and lists, then the project built.
//   node test/refactor-suite.js <empty folder>          (makes the project: Contoso.Shapes, a console app)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/refactor-suite.js node test/runTest.js
const fs = require('fs');
const path = require('path');

const SHAPES = `namespace Contoso.Shapes;

public class Shape
{
}

public class Circle : Shape
{
    public double Radius { get; set; }

    public double Area(double scale)
    {
        return 3.14 * Radius * Radius * scale;
    }

    public string Describe() => "circle";
}

public class Square : Shape
{
}
`;
const PROGRAM = `var circle = new Contoso.Shapes.Circle { Radius = 2 };
System.Console.WriteLine(circle.Area(1));
`;

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  execFileSync('dotnet', ['new', 'console', '-n', 'Contoso.Shapes', '-o', folder], { stdio: 'inherit' });
  fs.writeFileSync(path.join(folder, 'Shapes.cs'), SHAPES);
  fs.writeFileSync(path.join(folder, 'Program.cs'), PROGRAM);
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
  const ext = vscode.extensions.getExtension('M455YN.csharpshooter');
  const api = await ext.activate();
  await api.whenReady();
  for (let i = 0; i < 600 && api.loading() && !api.loading().done; i++) await sleep(500);
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = (name) => path.join(root, name);
  const read = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
  const before = Object.fromEntries(fs.readdirSync(root).filter((f) => f.endsWith('.cs')).map((f) => [f, read(f)]));

  // The answers a person gives: each input box takes the next one, each list the items a function picks.
  const answers = [];
  const window = vscode.window;
  const real = { showInputBox: window.showInputBox, showQuickPick: window.showQuickPick, showWarningMessage: window.showWarningMessage, showErrorMessage: window.showErrorMessage };
  // What a refactoring says when it refuses or fails, kept for the report.
  const said = [];
  window.showWarningMessage = async (m) => void said.push(m);
  window.showErrorMessage = async (m) => void said.push(m);
  window.showInputBox = async (options) => {
    const next = answers.shift();
    return typeof next === 'function' ? next(options) : next;
  };
  window.showQuickPick = async (items, options) => {
    const next = answers.shift();
    const list = await items;
    return next(list, options);
  };
  const caretAt = async (name, text, offset = 0) => {
    const doc = await vscode.workspace.openTextDocument(file(name));
    const editor = await vscode.window.showTextDocument(doc);
    const at = doc.positionAt(doc.getText().indexOf(text) + offset);
    editor.selection = new vscode.Selection(at, at);
    return editor;
  };

  try {
    // Ctrl+. on a method: Change Signature among the actions (the server has the file's C# by now).
    let editor = await caretAt('Shapes.cs', 'Area(double');
    let actions = [];
    for (let i = 0; i < 40 && !actions.some((a) => a.command?.command === 'csharpShooter.refactor.changeSignature'); i++) {
      actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', editor.document.uri, editor.selection, vscode.CodeActionKind.Refactor.value, 10);
      if (!actions.length) await sleep(500);
    }
    expect('Ctrl+. on a method offers Change Signature', actions.some((a) => a.command?.command === 'csharpShooter.refactor.changeSignature'),
      actions.filter((a) => a.command?.command?.startsWith('csharpShooter.refactor')).map((a) => a.title).join(', ') || 'none');

    // Change Signature: a parameter added, every call given the value for it.
    let value;
    answers.push((o) => ((value = o.value), 'double Area(double scale, int times)'), '2');
    await vscode.commands.executeCommand('csharpShooter.refactor.changeSignature');
    expect('Change Signature: the declaration and the call', /Area\(double scale, int times\)/.test(editor.document.getText()) && /circle\.Area\(1, 2\)/.test(read('Program.cs')),
      `box had "${value}"; call on disk ${/circle\.Area\([^)]*\)/.exec(read('Program.cs'))?.[0]}`);
    // As VS: Program.cs, in no tab, saved; Shapes.cs, open, left with its changes to save.
    expect('a file in no tab is saved, the open one left to save', !vscode.workspace.textDocuments.find((d) => /Program\.cs$/.test(d.fileName))?.isDirty && editor.document.isDirty,
      `Program.cs on disk changed, Shapes.cs dirty ${editor.document.isDirty}`);

    // Extract Interface: ICircle with every member, in ICircle.cs, which Circle then implements.
    editor = await caretAt('Shapes.cs', 'class Circle', 6);
    answers.push('ICircle', (list) => list);
    await vscode.commands.executeCommand('csharpShooter.refactor.extractInterface');
    await vscode.workspace.saveAll();
    expect('Extract Interface: ICircle.cs, Circle implements it', /interface ICircle/.test(read('ICircle.cs')) && /Circle : Shape, ICircle/.test(editor.document.getText()),
      `ICircle.cs ${read('ICircle.cs').length} chars; ${/class Circle[^\n{]*/.exec(editor.document.getText())?.[0]}`);

    // Pull Members Up: Describe into Shape.
    editor = await caretAt('Shapes.cs', 'class Circle', 6);
    answers.push((list) => list.filter((m) => /Describe/.test(m.label)), () => []);
    await vscode.commands.executeCommand('csharpShooter.refactor.pullMembersUp');
    let text = editor.document.getText();
    expect('Pull Members Up: Describe is Shape\'s', /class Shape\s*\{[^}]*Describe\(\)/.test(text), /class Shape[\s\S]*?\n\}/.exec(text)?.[0].replace(/\s+/g, ' '));

    // Push Members Down: Describe from Shape into Circle and Square, left abstract in Shape (Make abstract).
    editor = await caretAt('Shapes.cs', 'class Shape', 6);
    answers.push((list) => list, (list) => list.filter((m) => /Describe/.test(m.label)), (list) => list.filter((m) => /Describe/.test(m.label)));
    await vscode.commands.executeCommand('csharpShooter.refactor.pushMembersDown');
    text = editor.document.getText();
    expect('Push Members Down, Make abstract: an override in each derived class, abstract in Shape',
      (text.match(/override string Describe\(\)/g) || []).length === 2 && /abstract class Shape/.test(text) && /abstract string Describe\(\);/.test(text),
      `${(text.match(/override string Describe\(\)/g) || []).length} overrides; Shape abstract ${/abstract class Shape/.test(text)}`);

    // Move Type to File: Square into Square.cs.
    editor = await caretAt('Shapes.cs', 'class Square', 6);
    answers.push('Square.cs');
    await vscode.commands.executeCommand('csharpShooter.refactor.moveTypeToFile');
    await vscode.workspace.saveAll();
    expect('Move Type to File: Square.cs holds Square, Shapes.cs no longer', /class Square/.test(read('Square.cs')) && !/class Square/.test(read('Shapes.cs')), `Square.cs ${read('Square.cs').length} chars`);

    // Move to Namespace: Square into Contoso.Shapes.Squares.
    editor = await caretAt('Square.cs', 'class Square', 6);
    // The file just made joins its project once the server has seen it: until then Ctrl+. offers nothing of ours.
    for (let i = 0; i < 60; i++) {
      actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', editor.document.uri, editor.selection, vscode.CodeActionKind.Refactor.value, 10);
      if (actions.some((a) => a.command?.command === 'csharpShooter.refactor.moveToNamespace')) break;
      await sleep(500);
    }
    // With Preview Changes on: nothing changes until the Refactor Preview's Apply.
    const settings = vscode.workspace.getConfiguration('csharpShooter');
    await settings.update('previewRefactorings', true, vscode.ConfigurationTarget.Global);
    answers.push('Contoso.Shapes.Squares');
    const moving = vscode.commands.executeCommand('csharpShooter.refactor.moveToNamespace');
    await sleep(3000);
    const waited = !/namespace Contoso\.Shapes\.Squares/.test(editor.document.getText());
    // The panel's Apply, once the panel has the changes.
    let applied = false;
    moving.then(() => (applied = true));
    for (let i = 0; i < 30 && !applied; i++) {
      await vscode.commands.executeCommand('refactorPreview.apply').then(() => {}, () => {});
      await sleep(500);
    }
    await moving;
    await settings.update('previewRefactorings', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.saveAll();
    expect('Move to Namespace, previewed: unchanged until Apply, then Square is in Contoso.Shapes.Squares', waited && /namespace Contoso\.Shapes\.Squares/.test(read('Square.cs')),
      `before Apply unchanged ${waited}; ${/namespace [^;\n{]*/.exec(read('Square.cs'))?.[0]}; said: ${said.join(' | ') || 'nothing'}`);

    // What the refactorings made builds.
    const built = await new Promise((resolve) => require('child_process').execFile('dotnet', ['build', root, '-nologo', '-v', 'q'], { cwd: root },
      (e, out) => resolve({ ok: !e, out: String(out).split(/\r?\n/).filter((l) => /error/.test(l)).slice(0, 3).join(' | ') })));
    expect('the project builds after them', built.ok, built.ok ? 'built' : built.out);
  } finally {
    window.showInputBox = real.showInputBox;
    window.showQuickPick = real.showQuickPick;
    window.showWarningMessage = real.showWarningMessage;
    window.showErrorMessage = real.showErrorMessage;
    await vscode.workspace.saveAll();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const f of fs.readdirSync(root).filter((f) => f.endsWith('.cs') && !(f in before))) fs.rmSync(file(f));
    for (const [f, text] of Object.entries(before)) fs.writeFileSync(file(f), text);
  }
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
