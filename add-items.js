// Solution view → Add: New Folder, View (.cshtml), Controller (C#), as Visual Studio's Add menu makes them. Each takes
// the clicked item, then asks for a name; tests pass the name (and the controller's base class) instead.
const vscode = require('vscode');
const { t, tn } = require('./l10n');
const path = require('path');
const fs = require('fs');
const { readProject } = require('./solution');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The folder an item stands for, and its project file. A project's "Views"/"Controllers" when it has one and that is
 *  what is being added, as VS puts them. */
function targetOf(item, preferred) {
  if (item.kind === 'project') {
    const dir = path.dirname(item.file);
    const conventional = preferred && path.join(dir, preferred);
    return { dir: conventional && fs.existsSync(conventional) ? conventional : dir, project: item.file };
  }
  const p = item.resourceUri.fsPath;
  return { dir: item.kind === 'file' ? path.dirname(p) : p, project: item.project };
}

/** RootNamespace plus the folders below the project, each made an identifier, as VS names a new type's namespace. */
function namespaceFor(project, dir) {
  const parts = path.relative(path.dirname(project), dir).split(path.sep).filter(Boolean)
    .map((p) => p.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1'));
  return [readProject(project).rootNamespace, ...parts].join('.');
}

/** The project's C# files (bin/obj/node_modules left out), up to a limit: what the project's own style is read from. */
function csFiles(dir, limit = 400, found = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (found.length >= limit) break;
    if (e.isDirectory() && !/^(bin|obj|node_modules|\..*)$/i.test(e.name)) csFiles(path.join(dir, e.name), limit, found);
    else if (e.isFile() && e.name.endsWith('.cs')) found.push(path.join(dir, e.name));
  }
  return found;
}

/** How this project writes its controllers: base classes by use, file-scoped namespaces or not, line endings. */
function projectStyle(project) {
  const bases = new Map();
  let fileScoped = 0;
  let blocks = 0;
  let crlf = 0;
  for (const file of csFiles(path.dirname(project))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/class\s+\w+Controller\s*:\s*([\w.]+)/g)) bases.set(m[1], (bases.get(m[1]) || 0) + 1);
    if (/^namespace\s+[\w.]+\s*;/m.test(text)) fileScoped++;
    else if (/^namespace\s+[\w.]+\s*$/m.test(text)) blocks++;
    if (text.includes('\r\n')) crlf++;
  }
  return {
    bases: [...bases].sort((a, b) => b[1] - a[1]),
    fileScoped: fileScoped > blocks,
    eol: crlf > 0 || process.platform === 'win32' ? '\r\n' : '\n',
  };
}

/** The namespace a type is declared in: the language server finds the type, its file names the namespace (Roslyn's
 *  containerName is the project, not the namespace). Null when it is not found. */
async function namespaceOfType(name) {
  try {
    const symbols = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name)) || [];
    const hit = symbols.find((s) => s.name === name && s.kind === vscode.SymbolKind.Class && s.location.uri.scheme === 'file');
    if (!hit) return null;
    // shortcut: the file's first namespace; a file declaring several would need the one around the class.
    return /^\s*namespace\s+([\w.]+)/m.exec(fs.readFileSync(hit.location.uri.fsPath, 'utf8'))?.[1] || null;
  } catch {
    return null;
  }
}

async function askName(prompt, value, validate) {
  return vscode.window.showInputBox({ prompt, value, validateInput: validate });
}

/** Writes a new file, refusing to overwrite one, then opens it and shows it in the Solution view. */
async function create(file, text, reveal) {
  if (fs.existsSync(file)) {
    vscode.window.showErrorMessage(t('{0} already exists.', path.basename(file)));
    return undefined;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  await reveal(file);
  return file;
}

async function addFolder(item, name, reveal) {
  const { dir } = targetOf(item);
  name ??= await askName(t('New folder name'), 'NewFolder', (v) => (!v || /[<>:"/\\|?*]/.test(v) ? t('Not a folder name') : null));
  if (!name) return undefined;
  const folder = path.join(dir, name);
  if (fs.existsSync(folder)) {
    vscode.window.showErrorMessage(t('{0} already exists.', name));
    return undefined;
  }
  fs.mkdirSync(folder);
  await reveal(folder);
  return folder;
}

async function addView(item, name, reveal) {
  const { dir } = targetOf(item, 'Views');
  name ??= await askName(t('View name'), 'Index', (v) => (v && IDENTIFIER.test(v.replace(/\.cshtml$/i, '')) ? null : t('Not a view name')));
  if (!name) return undefined;
  name = name.replace(/\.cshtml$/i, '');
  const eol = process.platform === 'win32' ? '\r\n' : '\n';
  const text = ['@{', `    ViewData["Title"] = "${name}";`, '}', '', `<h1>${name}</h1>`, ''].join(eol);
  return create(path.join(dir, `${name}.cshtml`), text, reveal);
}

async function addController(item, name, reveal, options = {}) {
  const { dir, project } = targetOf(item, 'Controllers');
  if (!project) return undefined;
  name ??= await askName(t('Controller name'), 'HomeController', (v) => (v && IDENTIFIER.test(v) ? null : t('Not a class name')));
  if (!name) return undefined;
  if (!name.endsWith('Controller')) name += 'Controller';

  const style = projectStyle(project);
  let base = options.baseClass;
  if (!base) {
    const choices = [...style.bases.map(([b, n]) => ({ label: b, description: tn(n, 'used by 1 controller here', 'used by {0} controllers here') })),
      { label: 'Controller', description: t('MVC controller with views') }, { label: 'ControllerBase', description: t('API controller') }]
      .filter((c, i, all) => all.findIndex((x) => x.label === c.label) === i);
    base = (await vscode.window.showQuickPick(choices, { placeHolder: t('Base class of {0}', name) }))?.label;
    if (!base) return undefined;
  }

  const ns = namespaceFor(project, dir);
  const usings = new Set(['Microsoft.AspNetCore.Mvc']);
  if (!['Controller', 'ControllerBase'].includes(base)) {
    const baseNs = await namespaceOfType(base.split('.').pop());
    if (baseNs && baseNs !== ns) usings.add(baseNs);
  }
  const api = base === 'ControllerBase';
  const body = api
    ? ['[ApiController]', '[Route("api/[controller]")]', `public class ${name} : ${base}`, '{', '    [HttpGet]', '    public IActionResult Get()', '    {', '        return Ok();', '    }', '}']
    : [`public class ${name} : ${base}`, '{', '    public IActionResult Index()', '    {', '        return View();', '    }', '}'];
  const lines = [...[...usings].sort().map((u) => `using ${u};`), ''];
  if (style.fileScoped) lines.push(`namespace ${ns};`, '', ...body);
  else lines.push(`namespace ${ns}`, '{', ...body.map((l) => (l ? `    ${l}` : l)), '}');
  return create(path.join(dir, `${name}.cs`), lines.join(style.eol) + style.eol, reveal);
}

module.exports = { addFolder, addView, addController, namespaceFor, projectStyle };
