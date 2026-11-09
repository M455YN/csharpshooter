// The editor's help in a Blazor app's markup, in a real editor on a small app of the test's own: a start tag's '>' writes
// its end tag (in a .razor, a .cshtml, an .xml and a .csproj), CSS classes complete in class="…" from the stylesheets the
// app's pages link, and Go to Declaration on a JS interop call opens the JavaScript it calls.
//   node test/markup-suite.js <empty folder>          (makes the app: dotnet new blazor, a package of its own, a CDN's stand-in)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/markup-suite.js node test/runTest.js
const fs = require('fs');
const path = require('path');
const http = require('http');

// The CDN's stand-in: a stylesheet on a local server, which counts how often it was fetched.
const CDN_PORT = 5281;
const CDN_CSS = '.cdn-card { color: red; }\n@media (min-width: 1px) { .cdn-wide > .cdn-inner { margin: 0 } }\n';

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

const INTEROP_JS = `// The page's own module.
export function helper() { return 1; }

export function showAlert(message) {
  alert(message);
}
`;

const KIT_JS = `export const unused = 0;
export async function measure(n) {
  return n * 2;
}
`;

const GLOBALS_JS = `window.shopGlobals = {
  greet: function (n) {
    console.log(n);
  },
};

function globalTick() {
}
`;

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  const run = (...args) => execFileSync('dotnet', args, { stdio: 'inherit', cwd: folder });
  fs.mkdirSync(folder, { recursive: true });
  // The package: a Razor class library with a stylesheet and a module, packed into a feed of the folder's own.
  run('new', 'razorclasslib', '-n', 'Kit', '-o', 'kit-src');
  fs.writeFileSync(path.join(folder, 'kit-src', 'wwwroot', 'kit.css'), '/* the package\'s */\n.kit-card, .kit-card:hover { padding: 1px }\n');
  fs.writeFileSync(path.join(folder, 'kit-src', 'wwwroot', 'kit.js'), KIT_JS);
  run('pack', 'kit-src', '-o', 'feed', '-c', 'Release', '-p:PackageVersion=1.0.0');
  fs.writeFileSync(path.join(folder, 'nuget.config'), `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="local" value="feed" />
  </packageSources>
  <config>
    <add key="globalPackagesFolder" value="packages" />
  </config>
</configuration>
`);
  fs.rmSync(path.join(folder, 'kit-src'), { recursive: true, force: true });
  run('new', 'blazor', '-n', 'Shop', '-o', 'Shop', '--interactivity', 'Server');
  run('new', 'sln', '-n', 'Shop');
  run('sln', fs.readdirSync(folder).find((f) => /\.slnx?$/.test(f)), 'add', path.join('Shop', 'Shop.csproj'));
  run('add', path.join('Shop', 'Shop.csproj'), 'package', 'Kit', '--version', '1.0.0');
  const shop = path.join(folder, 'Shop');
  const app = path.join(shop, 'Components', 'App.razor');
  fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('</head>', `    <link rel="stylesheet" href="http://127.0.0.1:${CDN_PORT}/cdn.css" />
    <link rel="stylesheet" href="_content/Kit/kit.css" />
    <style>
        .inline-note { color: gray; }
    </style>
    <script src="js/globals.js"></script>
</head>`));
  fs.writeFileSync(path.join(shop, 'Components', 'Pages', 'Interop.razor'), INTEROP_PAGE);
  fs.writeFileSync(path.join(shop, 'Components', 'Pages', 'Interop.razor.js'), INTEROP_JS);
  fs.writeFileSync(path.join(shop, 'Components', 'Pages', 'Interop.razor.css'), '.scoped-title { font-weight: bold; }\n');
  fs.mkdirSync(path.join(shop, 'wwwroot', 'js'), { recursive: true });
  fs.writeFileSync(path.join(shop, 'wwwroot', 'js', 'globals.js'), GLOBALS_JS);
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
  let fetched = 0;
  const cdn = http.createServer((req, res) => {
    fetched++;
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end(CDN_CSS);
  });
  await new Promise((r) => cdn.listen(CDN_PORT, '127.0.0.1', r));
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

    // 2. CSS classes in class="…": the CDN's (fetched once), the package's, the isolation bundle's, wwwroot's and <style>'s.
    editor = await open(file('Shop', 'Components', 'Pages', 'Interop.razor'));
    at = caretAfter(editor, '<h1 class="');
    let labels = [];
    for (let i = 0; i < 30 && !labels.includes('cdn-card'); i++) {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', editor.document.uri, at);
      labels = list.items.map((c) => (typeof c.label === 'string' ? c.label : c.label.label));
      if (!labels.includes('cdn-card')) await sleep(500);
    }
    const want = ['cdn-card', 'cdn-wide', 'cdn-inner', 'kit-card', 'scoped-title', 'inline-note', 'btn-primary', 'valid'];
    expect('class="": every stylesheet\'s classes', want.every((c) => labels.includes(c)), `missing ${want.filter((c) => !labels.includes(c)).join(', ') || 'none'} among ${labels.length}`);
    await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', editor.document.uri, at);
    expect('the CDN\'s stylesheet is fetched once', fetched === 1, `${fetched} times`);
    const outside = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', editor.document.uri, caretAfter(editor, '<h1 '));
    expect('no classes outside class=""', !outside.items.some((c) => (c.label.label ?? c.label) === 'kit-card'), `${outside.items.length} items`);

    // 3. Go to Declaration on a JS interop call's identifier.
    const declaration = async (text, offset = 2, command = 'vscode.executeDeclarationProvider') => {
      const where = editor.document.positionAt(editor.document.getText().indexOf(text) + offset);
      const found = await vscode.commands.executeCommand(command, editor.document.uri, where);
      const l = found?.find((f) => /\.js$/.test((f.targetUri ?? f.uri).fsPath));
      if (!l) return 'none';
      const doc = await vscode.workspace.openTextDocument(l.targetUri ?? l.uri);
      return `${path.basename(doc.fileName)}: ${doc.lineAt((l.targetSelectionRange ?? l.targetRange ?? l.range).start.line).text.trim()}`;
    };
    let got = await declaration('"showAlert"');
    expect('F12: an imported module\'s export', got === 'Interop.razor.js: export function showAlert(message) {', got);
    got = await declaration('"measure"');
    expect('F12: a package\'s module imported with a cancellation token', got === 'kit.js: export async function measure(n) {', got);
    got = await declaration('"shopGlobals.greet"', 14);
    expect('F12: a global of wwwroot', got === 'globals.js: greet: function (n) {', got);
    got = await declaration('"globalTick"');
    expect('F12: IJSInProcessRuntime\'s InvokeVoid', got === 'globals.js: function globalTick() {', got);
    got = await declaration('"showAlert"', 2, 'vscode.executeDefinitionProvider');
    expect('Go to Definition too', got === 'Interop.razor.js: export function showAlert(message) {', got);
    got = await declaration('"./Components/Pages/Interop.razor.js"', 5);
    expect('F12 on an import\'s path opens the module', got === 'Interop.razor.js: // The page\'s own module.', got);
  } finally {
    cdn.close();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const [name, text] of backups) fs.writeFileSync(name, text);
  }
  console.log(`\n${lines.join('\n')}\n`);
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
