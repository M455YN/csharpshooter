// The editor's help in a Blazor app's markup, in a real editor on a small app of the test's own: a start tag's '>' writes
// its end tag (in a .razor, a .cshtml, an .xml and a .csproj).
//   node test/markup-suite.js <empty folder>          (makes the app: dotnet new blazor)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/markup-suite.js node test/runTest.js
const fs = require('fs');
const path = require('path');

const INTEROP_PAGE = `@page "/interop"
@inject IJSRuntime JS
@implements IAsyncDisposable

<h1 class="">Interop</h1>

@code {
    private IJSObjectReference? module;
    private IJSObjectReference? kit;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender) return;
        module = await JS.InvokeAsync<IJSObjectReference>("import", "./Components/Pages/Interop.razor.js");
        using var cts = new CancellationTokenSource();
        kit = await JS.InvokeAsync<IJSObjectReference>("import", cts.Token, new object[] { "./_content/Kit/kit.js" });
        await module.InvokeVoidAsync("showAlert", "hi");
        var size = await kit.InvokeAsync<int>("measure", TimeSpan.FromSeconds(2), new object[] { 3 });
        await JS.InvokeVoidAsync("shopGlobals.greet", size);
        ((IJSInProcessRuntime)JS).InvokeVoid("globalTick");
    }

    public async ValueTask DisposeAsync()
    {
        if (module is not null) await module.DisposeAsync();
    }
}
`;

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  const run = (...args) => execFileSync('dotnet', args, { stdio: 'inherit', cwd: folder });
  fs.mkdirSync(folder, { recursive: true });
  run('new', 'blazor', '-n', 'Shop', '-o', 'Shop', '--interactivity', 'Server');
  run('new', 'sln', '-n', 'Shop');
  run('sln', fs.readdirSync(folder).find((f) => /\.slnx?$/.test(f)), 'add', path.join('Shop', 'Shop.csproj'));
  const shop = path.join(folder, 'Shop');
  fs.writeFileSync(path.join(shop, 'Components', 'Pages', 'Interop.razor'), INTEROP_PAGE);
  fs.mkdirSync(path.join(shop, 'Pages'), { recursive: true });
  fs.writeFileSync(path.join(shop, 'Pages', 'Legacy.cshtml'), '@page\n<div>\n</div>\n');
  fs.writeFileSync(path.join(folder, 'notes.xml'), '<?xml version="1.0"?>\n<notes>\n</notes>\n');
  run('build', path.join('Shop', 'Shop.csproj'));
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
  // No completion list pops up while the keys are typed (a '>' would take its item).
  for (const languageId of ['aspnetcorerazor', 'xml']) {
    const editorSettings = vscode.workspace.getConfiguration('editor', { languageId });
    await editorSettings.update('quickSuggestions', { other: 'off', comments: 'off', strings: 'off' }, vscode.ConfigurationTarget.Global, true);
    await editorSettings.update('suggestOnTriggerCharacters', false, vscode.ConfigurationTarget.Global, true);
  }
  const ext = vscode.extensions.getExtension('M455YN.csharpshooter');
  const api = await ext.activate();
  await api.whenReady();
  for (let i = 0; i < 600 && api.loading() && !api.loading().done; i++) await sleep(500);
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = (...parts) => path.join(root, ...parts);
  const backups = new Map();
  const open = async (name) => {
    if (!backups.has(name)) backups.set(name, fs.readFileSync(name));
    const doc = await vscode.workspace.openTextDocument(name);
    return vscode.window.showTextDocument(doc);
  };
  const caretAfter = (editor, text, from = 0) => {
    const found = editor.document.getText().indexOf(text, from);
    if (found < 0) throw new Error(`${text} is not in ${editor.document.fileName}`);
    const at = editor.document.positionAt(found + text.length);
    editor.selection = new vscode.Selection(at, at);
    return at;
  };
  // Keys typed as a person types them, each through VS Code's own typing, one right after another.
  const type = async (text) => {
    for (const ch of text) await vscode.commands.executeCommand('type', { text: ch });
  };
  const lineOf = (editor, at) => editor.document.lineAt(at.line).text;
  // A line of its own, empty, after the text: the caret on it.
  const newLine = (editor, after) => {
    const at = caretAfter(editor, after);
    const line = new vscode.Position(at.line + 1, 0);
    editor.selection = new vscode.Selection(at, at);
    return editor.edit((b) => b.insert(at, editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')).then(() => {
      editor.selection = new vscode.Selection(line, line);
      return line;
    });
  };
  const settle = async (editor, done, ms = 8000) => {
    for (let i = 0; i < ms / 100 && !done(editor); i++) await sleep(100);
  };

  try {
    // 1. End tags. In a component: '>' of a start tag writes its end tag, the caret staying between them.
    let editor = await open(file('Shop', 'Components', 'Pages', 'Interop.razor'));
    let at = await newLine(editor, '<h1 class="">Interop</h1>');
    await type('<section');
    await type('>');
    // The caret, as the extension hears of it, comes after the text: waited for too.
    await settle(editor, (e) => lineOf(e, at) === '<section></section>' && e.selection.active.character === 9);
    expect('.razor: <section> gets </section>, the caret between', lineOf(editor, at) === '<section></section>' && editor.selection.active.character === '<section>'.length && editor.selection.active.line === at.line,
      `${JSON.stringify(lineOf(editor, at))}, caret at ${editor.selection.active.character}`);
    await vscode.commands.executeCommand('undo');
    expect('.razor: Undo takes the end tag back alone', lineOf(editor, at) === '<section>', JSON.stringify(lineOf(editor, at)));
    // Typed on fast: what comes after the '>' goes before the end tag, whenever the end tag comes.
    await vscode.commands.executeCommand('editor.action.insertLineAfter');
    at = editor.selection.active;
    await type('<p>quick');
    await settle(editor, (e) => lineOf(e, at).includes('</p>') && lineOf(e, at).indexOf('</p>') === e.selection.active.character);
    expect('.razor: typed on at once, the text lands inside', lineOf(editor, at).trim() === '<p>quick</p>' && lineOf(editor, at).indexOf('</p>') === editor.selection.active.character,
      `${JSON.stringify(lineOf(editor, at))}, caret at ${editor.selection.active.character}`);
    // A void element, a self-closing tag and a component closed in itself: nothing written.
    await vscode.commands.executeCommand('editor.action.insertLineAfter');
    at = editor.selection.active;
    await type('<br>');
    await vscode.commands.executeCommand('editor.action.insertLineAfter');
    await type('<hr />');
    await sleep(1500);
    expect('.razor: <br> and <hr /> are left alone', editor.document.lineAt(at.line).text.trim() === '<br>' && editor.document.lineAt(at.line + 1).text.trim() === '<hr />',
      `${JSON.stringify(editor.document.lineAt(at.line).text)} ${JSON.stringify(editor.document.lineAt(at.line + 1).text)}`);
    // C#'s generics in @code are no tags.
    at = caretAfter(editor, 'private IJSObjectReference? kit;');
    await type('\nprivate List<string');
    await type('>');
    await sleep(1500);
    expect('.razor: List<string> in @code is no tag', !/<\/string>/.test(editor.document.getText()), JSON.stringify(lineOf(editor, editor.selection.active)));
    await vscode.commands.executeCommand('workbench.action.files.revert');

    // A .cshtml's tags, and an XML file's, and a project file's.
    editor = await open(file('Shop', 'Pages', 'Legacy.cshtml'));
    at = await newLine(editor, '<div>');
    await type('<span');
    await type('>');
    await settle(editor, (e) => /<\/span>/.test(lineOf(e, at)));
    expect('.cshtml: <span> gets </span>', lineOf(editor, at).trim() === '<span></span>', JSON.stringify(lineOf(editor, at)));
    await vscode.commands.executeCommand('workbench.action.files.revert');

    editor = await open(file('notes.xml'));
    at = await newLine(editor, '<notes>');
    await type('<note>text');
    await settle(editor, (e) => lineOf(e, at).includes('</note>') && e.selection.active.character === 10);
    expect('.xml: <note> gets </note>, typed on inside', lineOf(editor, at) === '<note>text</note>' && editor.selection.active.character === '<note>text'.length,
      `${JSON.stringify(lineOf(editor, at))}, caret at ${editor.selection.active.character}`);
    at = await newLine(editor, '</note>');
    await type('<br>');
    await sleep(1000);
    expect('.xml: <br> is an element in XML and gets its end tag', /<br><\/br>/.test(lineOf(editor, at)), JSON.stringify(lineOf(editor, at)));
    await vscode.commands.executeCommand('workbench.action.files.revert');

    editor = await open(file('Shop', 'Shop.csproj'));
    at = await newLine(editor, '<PropertyGroup>');
    await type('<Description');
    await type('>');
    await settle(editor, (e) => /<\/Description>/.test(lineOf(e, at)));
    expect('.csproj: <Description> gets </Description>', lineOf(editor, at).trim() === '<Description></Description>', JSON.stringify(lineOf(editor, at)));
    // A condition's '>' is in a value, no tag.
    at = await newLine(editor, '</Description>');
    await type("<Foo Condition=\"'$(X)' > '1'\" />");
    await sleep(1000);
    expect('.csproj: a condition\'s > and a self-closing tag are left alone', !/<\/Foo>/.test(editor.document.getText()), JSON.stringify(lineOf(editor, at)));
    await vscode.commands.executeCommand('workbench.action.files.revert');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const [name, text] of backups) fs.writeFileSync(name, text);
  }
  console.log(`\n${lines.join('\n')}\n`);
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
