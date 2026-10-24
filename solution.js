// Solution view, after Visual Studio's Solution Explorer: the solution, its solution folders and projects, each project's
// Dependencies and its files as VS shows them (bin/obj hidden, related files nested under the one they belong to).
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const SOLUTION_FOLDER = '2150E333-8FDC-42A3-9474-1A3956D46DE8';
// What VS leaves out of an SDK project's tree.
const HIDDEN_DIRS = new Set(['bin', 'obj', 'node_modules', '.vs', '.git']);
const isHiddenFile = (name) => name.endsWith('.user') || name.startsWith('.');

/** Projects and solution folders of a .sln or .slnx, as a tree: { name, folders: [...], projects: [path] }. */
function readSolution(file) {
  const dir = path.dirname(file);
  const text = fs.readFileSync(file, 'utf8');
  const root = { name: path.basename(file, path.extname(file)), folders: [], projects: [] };
  if (file.toLowerCase().endsWith('.slnx')) {
    // <Folder Name="/a/b/"><Project Path="x.csproj" /></Folder>, or <Project> at the root.
    const folderOf = (name) => name.split('/').filter(Boolean).reduce((parent, part) => {
      let f = parent.folders.find((x) => x.name === part);
      if (!f) parent.folders.push((f = { name: part, folders: [], projects: [] }));
      return f;
    }, root);
    const folderRe = /<Folder\s+Name="([^"]+)"\s*(\/>|>([\s\S]*?)<\/Folder>)/g;
    let m;
    let rest = text;
    while ((m = folderRe.exec(text))) {
      const f = folderOf(m[1]);
      for (const p of (m[3] || '').matchAll(/<Project\s+Path="([^"]+)"/g)) f.projects.push(path.resolve(dir, p[1]));
      rest = rest.replace(m[0], '');
    }
    for (const p of rest.matchAll(/<Project\s+Path="([^"]+)"/g)) root.projects.push(path.resolve(dir, p[1]));
    return root;
  }
  // Project("{type}") = "Name", "path", "{guid}", then NestedProjects: {child} = {parent}.
  const entries = new Map();
  for (const m of text.matchAll(/Project\("\{([^}]+)\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"\{([^}]+)\}"/g)) {
    const folder = m[1].toUpperCase() === SOLUTION_FOLDER;
    entries.set(m[4].toUpperCase(), folder ? { name: m[2], folders: [], projects: [] } : { project: path.resolve(dir, m[3].replace(/\\/g, path.sep)) });
  }
  const nested = new Map();
  const section = /GlobalSection\(NestedProjects\)[\s\S]*?EndGlobalSection/.exec(text);
  for (const m of (section ? section[0] : '').matchAll(/\{([^}]+)\}\s*=\s*\{([^}]+)\}/g)) nested.set(m[1].toUpperCase(), m[2].toUpperCase());
  for (const [guid, entry] of entries) {
    const parent = entries.get(nested.get(guid)) || root;
    if (entry.project) parent.projects.push(entry.project);
    else parent.folders.push(entry);
  }
  return root;
}

/** Project and package references and target frameworks of a project file, its XML comments left out. */
function readProject(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const attr = (tag, name) => [...text.matchAll(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"[^>]*>`, 'g'))];
  const frameworks = (/<TargetFrameworks?>([^<]+)</.exec(text)?.[1] || '').split(';').filter(Boolean);
  return {
    sdk: /<Project\s+Sdk="([^"]+)"/.exec(text)?.[1] || '',
    rootNamespace: /<RootNamespace>([^<]+)</.exec(text)?.[1] || path.basename(file, path.extname(file)),
    frameworks,
    projects: attr('ProjectReference', 'Include').map((m) => path.resolve(path.dirname(file), m[1].replace(/\\/g, path.sep))),
    packages: attr('PackageReference', 'Include').map((m) => ({ id: m[1], version: /Version="([^"]+)"/.exec(m[0])?.[1] || '' })),
  };
}

/** Which file each file nests under, as VS nests them: Foo.cshtml.cs under Foo.cshtml, appsettings.Development.json
 *  under appsettings.json, jquery.min.js under jquery.js, Resources.Designer.cs under Resources.resx. */
function nestingParents(names) {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const parents = new Map();
  for (const name of names) {
    const lower = name.toLowerCase();
    const ext = path.extname(lower);
    const candidates = [
      lower.slice(0, -ext.length), // Foo.cshtml.cs -> Foo.cshtml, site.css.map -> site.css
      lower.replace(/\.[^.]+(\.[^.]+)$/, '$1'), // appsettings.Development.json -> appsettings.json, x.min.js -> x.js
      lower.replace(/\.designer\.cs$/, '.resx'),
    ];
    const parent = candidates.find((c) => c !== lower && path.extname(c) && set.has(c));
    if (parent) parents.set(name, byLower.get(parent));
  }
  // A file whose parent nests under another goes under that one too (x.min.js.map under x.min.js under x.js).
  return parents;
}

class Item extends vscode.TreeItem {
  constructor(kind, label, collapsible, extra = {}) {
    super(label, collapsible);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// Codicons in Visual Studio's colours: purple solution, green C# project, blue web project and packages, yellow folders.
const icon = (name, color) => new vscode.ThemeIcon(name, color ? new vscode.ThemeColor(color) : undefined);
// A folder gets an SVG of its own: the 'folder' codicon is the file icon theme's folder, which Seti draws as nothing.
const YELLOW_FOLDER = vscode.Uri.file(path.join(__dirname, 'media', 'folder.svg'));
const FOLDER_ICONS = { properties: icon('tools', 'charts.blue'), wwwroot: icon('globe', 'charts.blue') };
const folderIcon = (name) => FOLDER_ICONS[name.toLowerCase()] || YELLOW_FOLDER;

const NONE = vscode.TreeItemCollapsibleState.None;
const COLLAPSED = vscode.TreeItemCollapsibleState.Collapsed;
const EXPANDED = vscode.TreeItemCollapsibleState.Expanded;

class SolutionProvider {
  constructor(findSolution) {
    this.findSolution = findSolution;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.parents = new Map(); // item id -> parent item, for reveal
  }

  refresh() {
    this.parents.clear();
    this.changed.fire();
  }

  getTreeItem(item) {
    return item;
  }

  getParent(item) {
    return this.parents.get(item.id);
  }

  remember(parent, children) {
    for (const c of children) {
      this.parents.set(c.id, parent);
    }
    return children;
  }

  async getChildren(item) {
    if (!item) {
      const file = await this.findSolution();
      if (!file) return [];
      this.solution = readSolution(file);
      const count = countProjects(this.solution);
      return this.remember(undefined, [new Item('solution', `Solution '${this.solution.name}'`, EXPANDED, {
        id: `sln:${file}`, description: `${count} project${count === 1 ? '' : 's'}`, node: this.solution, file,
        iconPath: icon('symbol-namespace', 'charts.purple'), contextValue: 'solution', tooltip: file,
      })]);
    }
    return this.remember(item, this.childrenOf(item));
  }

  childrenOf(item) {
    switch (item.kind) {
      case 'solution':
      case 'solutionFolder':
        return [
          ...item.node.folders.sort((a, b) => a.name.localeCompare(b.name)).map((f) => new Item('solutionFolder', f.name, COLLAPSED, {
            id: `${item.id}/${f.name}`, node: f, iconPath: YELLOW_FOLDER, contextValue: 'solutionFolder',
          })),
          ...item.node.projects.sort((a, b) => path.basename(a).localeCompare(path.basename(b))).map((p) => this.projectItem(p)),
        ];
      case 'project': {
        const dir = path.dirname(item.file);
        return [
          new Item('dependencies', 'Dependencies', COLLAPSED, { id: `${item.id}#deps`, file: item.file, iconPath: icon('references', 'charts.purple') }),
          ...this.folderChildren(dir, item.id, item.file),
        ];
      }
      case 'dependencies': {
        let project;
        try {
          project = readProject(item.file);
        } catch {
          return [];
        }
        const groups = [
          ['Frameworks', project.frameworks.map((f) => ({ label: f, icon: icon('library', 'charts.purple') }))],
          ['Projects', project.projects.map((p) => ({ label: path.basename(p, path.extname(p)), icon: icon('project', 'charts.green'), file: p }))],
          ['Packages', project.packages.map((p) => ({ label: p.id, description: p.version, icon: icon('package', 'charts.blue') }))],
        ].filter(([, list]) => list.length);
        return groups.map(([name, list]) => new Item('depGroup', name, COLLAPSED, { id: `${item.id}/${name}`, list, iconPath: YELLOW_FOLDER }));
      }
      case 'depGroup':
        return item.list.map((d) => new Item('dependency', d.label, NONE, {
          id: `${item.id}/${d.label}`, description: d.description, iconPath: d.icon,
          ...(d.file ? { command: { command: 'csharpShooter.solution.revealProject', title: 'Show project', arguments: [d.file] } } : {}),
        }));
      case 'folder':
        return this.folderChildren(item.resourceUri.fsPath, item.id, item.project);
      case 'file':
        return item.nested.map((f) => this.fileItem(f, item.id, path.dirname(item.resourceUri.fsPath)));
      default:
        return [];
    }
  }

  projectItem(file) {
    let sdk = '';
    try {
      sdk = readProject(file).sdk;
    } catch {
      // A project the solution names but the disk does not have: listed, empty.
    }
    const name = path.basename(file, path.extname(file));
    return new Item('project', name, COLLAPSED, {
      id: `proj:${file}`, file, resourceUri: vscode.Uri.file(file), contextValue: 'project', tooltip: file,
      description: sdk.endsWith('.Web') ? 'web' : undefined,
      iconPath: sdk.endsWith('.Web') ? icon('globe', 'charts.blue') : icon('project', 'charts.green'),
    });
  }

  folderChildren(dir, parentId, project) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const folders = entries.filter((e) => e.isDirectory() && !HIDDEN_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.'))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const files = entries.filter((e) => e.isFile() && !isHiddenFile(e.name) && !/\.(cs|vb|fs)proj$/i.test(e.name)).map((e) => e.name);
    const parents = nestingParents(files);
    const top = files.filter((f) => !parents.has(f)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const nestedUnder = (name) => files.filter((f) => parents.get(f) === name).map((f) => ({ name: f, nested: nestedUnder(f) }));
    return [
      ...folders.map((f) => new Item('folder', f, COLLAPSED, {
        id: `${parentId}/${f}`, resourceUri: vscode.Uri.file(path.join(dir, f)), contextValue: 'folder', project, iconPath: folderIcon(f),
      })),
      ...top.map((f) => this.fileItem({ name: f, nested: nestedUnder(f) }, parentId, dir)),
    ];
  }

  fileItem(entry, parentId, dir) {
    const full = path.join(dir, entry.name);
    return new Item('file', entry.name, entry.nested.length ? COLLAPSED : NONE, {
      id: `${parentId}/${entry.name}`, resourceUri: vscode.Uri.file(full), contextValue: 'file', nested: entry.nested,
      command: { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(full)] },
    });
  }
}

function countProjects(node) {
  return node.projects.length + node.folders.reduce((n, f) => n + countProjects(f), 0);
}

/** Walks the tree down to a file, so the view can reveal it (Sync with Active Document). */
async function findItem(provider, fsPath) {
  const target = fsPath.toLowerCase();
  let level = await provider.getChildren();
  for (let depth = 0; depth < 40 && level.length; depth++) {
    const hit = level.find((i) => i.resourceUri && i.resourceUri.fsPath.toLowerCase() === target);
    if (hit) return hit;
    const next = level.find((i) => {
      if (i.kind === 'solution' || i.kind === 'solutionFolder') return countProjectsUnder(i.node, target);
      const p = i.kind === 'project' ? path.dirname(i.file) : i.resourceUri?.fsPath;
      if (!p) return false;
      const lower = p.toLowerCase();
      // A folder holds the file below it; a file holds the files nested under it.
      return target.startsWith(lower + path.sep) || (i.kind === 'file' && i.nested.length && isNestedUnder(i, target));
    });
    if (!next) return undefined;
    level = await provider.getChildren(next);
  }
  return undefined;
}

function countProjectsUnder(node, target) {
  return node.projects.some((p) => target.startsWith(path.dirname(p).toLowerCase() + path.sep)) || node.folders.some((f) => countProjectsUnder(f, target));
}

function isNestedUnder(item, target) {
  const dir = path.dirname(item.resourceUri.fsPath).toLowerCase();
  const walk = (list) => list.some((n) => path.join(dir, n.name).toLowerCase() === target || walk(n.nested));
  return walk(item.nested);
}

function registerSolutionView(context, findSolution) {
  const provider = new SolutionProvider(findSolution);
  const view = vscode.window.createTreeView('csharpShooter.solution', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(view);

  let timer;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 500);
  };
  // Files that come and go change the tree; edits to a file do not, except a project's or the solution's.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const relevant = (uri) => !/[\\/](bin|obj|node_modules|\.git|\.vs)[\\/]/i.test(uri.fsPath);
  watcher.onDidCreate((u) => relevant(u) && refreshSoon());
  watcher.onDidDelete((u) => relevant(u) && refreshSoon());
  watcher.onDidChange((u) => /\.(csproj|sln|slnx)$/i.test(u.fsPath) && refreshSoon());
  context.subscriptions.push(watcher);

  // A dotnet command in a task; resolves with its exit code once it ends.
  const terminalTask = async (name, cmd, cwd) => {
    const execution = await vscode.tasks.executeTask(new vscode.Task({ type: 'shell', task: name }, vscode.TaskScope.Workspace, name, 'CSharpShooter', new vscode.ShellExecution(cmd, { cwd })));
    return new Promise((resolve) => {
      const done = vscode.tasks.onDidEndTaskProcess((e) => e.execution === execution && (done.dispose(), resolve(e.exitCode)));
    });
  };
  // A build with the Task Runner's bindings around it (csharpShooter.taskRunner.buildBindings): a solution's are all of them.
  const { buildBindings } = require('./task-runner');
  const bound = async (item, before, run, after) => {
    const folder = item.kind === 'project' ? path.dirname(item.file) : undefined;
    if (!(await buildBindings(before, folder))) return;
    if ((await run()) === 0 && after) await buildBindings(after, folder);
  };
  const target = (item) => item.file; // the .sln or the project file
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('csharpShooter.solution.refresh', () => provider.refresh());
  register('csharpShooter.solution.build', (item) => bound(item, 'BeforeBuild', () => terminalTask(`build ${item.label}`, `dotnet build "${target(item)}"`, path.dirname(target(item))), 'AfterBuild'));
  register('csharpShooter.solution.rebuild', (item) => bound(item, 'BeforeBuild', () => terminalTask(`rebuild ${item.label}`, `dotnet build --no-incremental "${target(item)}"`, path.dirname(target(item))), 'AfterBuild'));
  register('csharpShooter.solution.clean', (item) => bound(item, 'Clean', () => terminalTask(`clean ${item.label}`, `dotnet clean "${target(item)}"`, path.dirname(target(item)))));
  register('csharpShooter.solution.editProject', (item) => vscode.window.showTextDocument(vscode.Uri.file(item.file)));
  register('csharpShooter.solution.revealInOS', (item) => vscode.commands.executeCommand('revealFileInOS', item.resourceUri || vscode.Uri.file(item.file)));
  register('csharpShooter.solution.copyPath', (item) => vscode.env.clipboard.writeText((item.resourceUri || vscode.Uri.file(item.file)).fsPath));
  register('csharpShooter.solution.openInTerminal', (item) => {
    const p = item.resourceUri?.fsPath || item.file;
    const dir = item.kind === 'folder' ? p : path.dirname(p);
    vscode.window.createTerminal({ cwd: dir, name: path.basename(dir) }).show();
  });
  register('csharpShooter.solution.revealProject', async (file) => {
    const level = await provider.getChildren();
    const walk = async (items) => {
      for (const i of items) {
        if (i.kind === 'project' && i.file.toLowerCase() === file.toLowerCase()) return i;
        if (i.kind === 'solution' || i.kind === 'solutionFolder') {
          const found = await walk(await provider.getChildren(i));
          if (found) return found;
        }
      }
      return undefined;
    };
    const item = await walk(level);
    if (item) await view.reveal(item, { select: true, focus: true, expand: true });
  });
  // Shows what Add made: the tree read afresh, walked down to it.
  const revealPath = async (fsPath) => {
    provider.refresh();
    const item = await findItem(provider, fsPath);
    if (item) await view.reveal(item, { select: true, focus: false, expand: true });
  };
  const add = require('./add-items'); // late: add-items reads projects through this module
  register('csharpShooter.solution.addFolder', (item, name) => add.addFolder(item, name, revealPath));
  register('csharpShooter.solution.addView', (item, name) => add.addView(item, name, revealPath));
  register('csharpShooter.solution.addController', (item, name, options) => add.addController(item, name, revealPath, options));
  register('csharpShooter.solution.syncWithActive', async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') return;
    const item = await findItem(provider, uri.fsPath);
    if (item) await view.reveal(item, { select: true, focus: true, expand: true });
  });
  return { provider, view, findItem: (p) => findItem(provider, p) };
}

module.exports = { registerSolutionView, readSolution, readProject, nestingParents };
