// Go to Declaration (and Definition, F12) on the identifier a JS interop call gives (IJSRuntime's, an IJSObjectReference's,
// IJSInProcessRuntime's InvokeAsync, InvokeVoidAsync, Invoke…) opens the JavaScript function it calls, as Visual Studio does:
// in the module the reference was imported from ("import" of a constant path, with a cancellation token or a timeout too,
// a Lazy's .Value followed), else among the app's scripts (wwwroot, a referenced project's or a package's static web
// assets) for a global. The call is the server's to tell: its hover on the method must name JS interop's types. On the
// path an "import" gives, the module itself opens.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const assets = require('./web-assets');

const METHODS = 'InvokeAsync|InvokeVoidAsync|Invoke|InvokeVoid|InvokeConstructorAsync|InvokeConstructor|InvokeNewAsync|InvokeNew|GetValueAsync|GetValue|SetValueAsync|SetValue';
// A call up to its first argument, the string the caret is in: the receiver, the method, its type arguments.
const CALL = new RegExp(String.raw`([\w\]\)]+)\s*\??\.\s*(${METHODS})\s*(?:<[^()]*?>)?\s*\(\s*$`);
// An "import" call up to the path the caret is in, its token or timeout and the args array's start passed over.
const IMPORT = new RegExp(String.raw`(?:${METHODS})\s*(?:<[^()]*?>)?\s*\(\s*"import"\s*,[^;"]*$`);
const INTEROP_TYPES = /\bIJS(?:InProcess)?(?:Runtime|ObjectReference)\b|\bJS(?:InProcess)?(?:Runtime|ObjectReference)Extensions\b|Microsoft\.JSInterop/;

/** The string literal the position is in, on its line: its text and where it starts; null outside one. */
function stringAt(document, position) {
  const line = document.lineAt(position.line).text;
  const quotes = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') quotes.push(i);
  }
  for (let q = 0; q + 1 < quotes.length; q += 2) {
    if (quotes[q] < position.character && position.character <= quotes[q + 1]) {
      return { text: line.slice(quotes[q] + 1, quotes[q + 1]), start: document.offsetAt(new vscode.Position(position.line, quotes[q])) };
    }
  }
  return null;
}

/** The modules a file's code imports, by what holds each: holder name -> path; a Lazy's or Task's holder read through. */
function importedModules(text) {
  const modules = new Map();
  const imports = new RegExp(String.raw`(\w+)\s*=\s*(?:new\s*(?:\w+\s*)?(?:<[^()]*?>)?\s*\(\s*\(\)\s*=>\s*)?(?:await\s+)?[\w.()]*?(?:${METHODS})\s*<\s*IJS(?:InProcess)?ObjectReference\s*>\s*\(\s*"import"\s*,[^;"]*"([^"]+)"`, 'g');
  for (const m of text.matchAll(imports)) modules.set(m[1], m[2]);
  for (const m of text.matchAll(/(\w+)\s*=\s*await\s+(?:this\.)?(\w+)(?:\.Value)?\s*;/g)) if (modules.has(m[2]) && !modules.has(m[1])) modules.set(m[1], modules.get(m[2]));
  return modules;
}

/** Where a script declares a function or value of the name: an export, a function, a property or variable given one. */
function declarationIn(text, name) {
  const n = name.replace(/[$]/g, '\\$');
  const patterns = [
    String.raw`\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(${n})\s*\(`,
    String.raw`\bexport\s+(?:const|let|var)\s+(${n})\b`,
    String.raw`\b(?:async\s+)?function\s*\*?\s*(${n})\s*\(`,
    String.raw`(?:^|[\s,{;.])(${n})\s*[:=]\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)`,
    String.raw`^[ \t]*(?:async\s+)?(${n})\s*\([^()]*\)\s*\{`,
    String.raw`\b(?:class|const|let|var)\s+(${n})\b`,
  ];
  for (const p of patterns) {
    const m = new RegExp(p, 'm').exec(text);
    if (m) return m.index + m[0].lastIndexOf(m[1]);
  }
  return -1;
}

function registerJsInterop(context) {
  const provider = {
    async provide(document, position) {
      const literal = stringAt(document, position);
      if (!literal) return undefined;
      const text = document.getText();
      const before = text.slice(Math.max(0, literal.start - 400), literal.start);
      const project = assets.projectOf(document.fileName);
      if (!project) return undefined;
      const projects = (await vscode.workspace.findFiles('**/*.{csproj,fsproj,vbproj}', '**/{node_modules,bin,obj}/**')).map((u) => u.fsPath);
      // The projects whose files the app serves: the file's, those it references, those that reference it.
      const near = [...new Set([...assets.referencedFrom(project), ...assets.referencingTo(project, projects)])];
      const resolve = (href) => near.map((p) => assets.assetFile(p, href)).find(Boolean);

      if (IMPORT.test(before) && literal.text !== 'import') {
        const file = resolve(literal.text);
        return file ? new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0)) : undefined;
      }
      const call = CALL.exec(before);
      if (!call || literal.text === 'import') return undefined;
      const method = await hoverText(document, literal.start - before.length + call.index + call[0].indexOf(call[2], call[1].length));
      if (!INTEROP_TYPES.test(method)) return undefined;
      const receiver = call[1];
      const modules = importedModules(text);
      const name = literal.text.split('.').at(-1);
      let scripts;
      if (modules.has(receiver)) {
        scripts = [resolve(modules.get(receiver))];
      } else if (/ObjectReference/.test(method)) {
        scripts = [...modules.values()].map(resolve);
      } else {
        // A global: the app's scripts, its own first, those whose text names the identifier's first part first.
        scripts = near.flatMap((p) => assets.filesUnder(path.join(path.dirname(p), 'wwwroot'), (f) => /\.m?js$/i.test(f) && !/\.min\.js$/i.test(f)));
        const first = literal.text.split('.')[0];
        scripts.sort((a, b) => Number(read(b).includes(first)) - Number(read(a).includes(first)));
      }
      const found = [];
      for (const script of scripts.filter(Boolean)) {
        const source = read(script);
        const at = declarationIn(source, name);
        if (at < 0) continue;
        const doc = await vscode.workspace.openTextDocument(script);
        const start = doc.positionAt(at);
        found.push(new vscode.Location(doc.uri, new vscode.Range(start, start.translate(0, name.length))));
        if (modules.has(receiver) || literal.text.includes('.')) break;
      }
      return found;
    },
  };
  const read = (file) => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && assets.same(d.fileName, file));
    if (open) return open.getText();
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  };
  const selector = [{ language: 'csharp' }, { language: 'aspnetcorerazor' }];
  context.subscriptions.push(
    vscode.languages.registerDeclarationProvider(selector, { provideDeclaration: (d, p) => provider.provide(d, p) }),
    vscode.languages.registerDefinitionProvider(selector, { provideDefinition: (d, p) => provider.provide(d, p) }));
}

/** The server's hover on a method: what it says it is. */
async function hoverText(document, offset) {
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, document.positionAt(offset + 1)) || [];
  return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
}

module.exports = { registerJsInterop, importedModules, declarationIn };
