// Solution view, after Visual Studio's Solution Explorer: the solution, its solution folders and projects, each project's
// Dependencies and its files as VS shows them (bin/obj hidden, related files nested under the one they belong to).
const vscode = require('vscode');
const { t, tn, n_ } = require('./l10n');
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
    this.startupProject = undefined; // marked as VS marks it (bold there, "projekt startowy" here)
    // The search's result, as VS filters its tree: { gen, hits: Map(lower path -> { ranges, lines }), keep: Set(lower path) }.
    this.filter = null;
  }

  setFilter(filter) {
    this.filter = filter;
    this.refresh();
  }

  setStartup(project) {
    this.startupProject = project;
    this.refresh();
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
      return this.remember(undefined, [new Item('solution', t("Solution '{0}'", this.solution.name), EXPANDED, {
        // A filtered tree has ids of its own, so its folders open expanded whatever the user had collapsed.
        id: this.filter ? `sln?${this.filter.gen}:${file}` : `sln:${file}`, filter: this.filter, description: tn(count, '1 project', '{0} projects'), node: this.solution, file,
        iconPath: icon('symbol-namespace', 'charts.purple'), contextValue: 'solution', tooltip: file,
      })]);
    }
    return this.remember(item, this.childrenOf(item));
  }

  childrenOf(item) {
    const f = item.filter; // set on the items of a filtered tree, except under a hit (a hit shows all it holds)
    const kept = (p) => !f || f.keep.has(p.toLowerCase()) || f.hits.has(p.toLowerCase());
    switch (item.kind) {
      case 'solution':
      case 'solutionFolder':
        return [
          ...item.node.folders.filter((x) => !f || countProjectsKept(x, kept)).sort((a, b) => a.name.localeCompare(b.name))
            .map((x) => new Item('solutionFolder', x.name, f ? EXPANDED : COLLAPSED, {
              id: `${item.id}/${x.name}`, node: x, iconPath: YELLOW_FOLDER, contextValue: 'solutionFolder', filter: f,
            })),
          ...item.node.projects.filter(kept).sort((a, b) => path.basename(a).localeCompare(path.basename(b))).map((p) => this.projectItem(p, f)),
        ];
      case 'project': {
        const dir = path.dirname(item.file);
        return [
          ...(f ? [] : [new Item('dependencies', t('Dependencies'), COLLAPSED, { id: `${item.id}#deps`, file: item.file, iconPath: icon('references', 'charts.purple') })]),
          ...this.folderChildren(dir, item.id, item.file, f),
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
          [n_('Frameworks'), project.frameworks.map((f) => ({ label: f, icon: icon('library', 'charts.purple') }))],
          [n_('Projects'), project.projects.map((p) => ({ label: path.basename(p, path.extname(p)), icon: icon('project', 'charts.green'), file: p }))],
          [n_('Packages'), project.packages.map((p) => ({ label: p.id, description: p.version, icon: icon('package', 'charts.blue') }))],
        ].filter(([, list]) => list.length);
        return groups.map(([name, list]) => new Item('depGroup', t(name), COLLAPSED, { id: `${item.id}/${name}`, list, iconPath: YELLOW_FOLDER }));
      }
      case 'depGroup':
        return item.list.map((d) => new Item('dependency', d.label, NONE, {
          id: `${item.id}/${d.label}`, description: d.description, iconPath: d.icon,
          ...(d.file ? { command: { command: 'csharpShooter.solution.revealProject', title: 'Show project', arguments: [d.file] } } : {}),
        }));
      case 'folder':
        return this.folderChildren(item.resourceUri.fsPath, item.id, item.project, f);
      case 'file':
        return [
          ...item.nested.map((n) => this.fileItem(n, item.id, path.dirname(item.resourceUri.fsPath), f)),
          ...item.lines.map((l) => new Item('line', { label: l.text, highlights: [l.range] }, NONE, {
            id: `${item.id}:${l.line}`, description: `${l.line}`, iconPath: icon('search'),
            command: { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri, { selection: new vscode.Range(l.line - 1, l.range[0], l.line - 1, l.range[1]) }] },
          })),
        ];
      default:
        return [];
    }
  }

  projectItem(file, f) {
    let sdk = '';
    let runnable = false;
    try {
      sdk = readProject(file).sdk;
      runnable = sdk.endsWith('.Web') || /<OutputType>\s*(Win)?Exe\s*</i.test(fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ''));
    } catch {
      // A project the solution names but the disk does not have: listed, empty.
    }
    const name = path.basename(file, path.extname(file));
    const startup = !!this.startupProject && path.resolve(this.startupProject).toLowerCase() === path.resolve(file).toLowerCase();
    const hit = f?.hits.has(file.toLowerCase());
    return new Item('project', name, f && !hit ? EXPANDED : COLLAPSED, {
      id: `proj${f ? `?${f.gen}` : ''}:${file}`, file, filter: hit ? null : f, resourceUri: vscode.Uri.file(file), tooltip: file,
      // "project", " runnable" when it can be a startup project (an Exe or a web project, as VS has it), " startup" when it is.
      contextValue: ['project', ...(runnable ? ['runnable'] : []), ...(startup ? ['startup'] : [])].join(' '),
      description: [sdk.endsWith('.Web') ? 'web' : '', startup ? t('startup project') : ''].filter(Boolean).join(' · ') || undefined,
      iconPath: sdk.endsWith('.Web') ? icon('globe', 'charts.blue') : icon('project', 'charts.green'),
    });
  }

  folderChildren(dir, parentId, project, f) {
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
    const nestedUnder = (name) => files.filter((x) => parents.get(x) === name).map((x) => ({ name: x, nested: nestedUnder(x) }));
    const hitOf = (name) => f?.hits.get(path.join(dir, name).toLowerCase());
    const keepFile = (e) => !!hitOf(e.name) || e.nested.some(keepFile);
    return [
      ...folders.filter((x) => !f || f.keep.has(path.join(dir, x).toLowerCase()) || hitOf(x)).map((x) => new Item('folder', label(x, hitOf(x)), f && !hitOf(x) ? EXPANDED : COLLAPSED, {
        id: `${parentId}/${x}`, resourceUri: vscode.Uri.file(path.join(dir, x)), contextValue: 'folder', project, iconPath: folderIcon(x), filter: hitOf(x) ? null : f,
      })),
      ...top.map((x) => ({ name: x, nested: nestedUnder(x) })).filter((e) => !f || keepFile(e)).map((e) => this.fileItem(e, parentId, dir, f)),
    ];
  }

  fileItem(entry, parentId, dir, f) {
    const full = path.join(dir, entry.name);
    const hit = f?.hits.get(full.toLowerCase());
    const keepFile = (e) => !!f.hits.get(path.join(dir, e.name).toLowerCase()) || e.nested.some(keepFile);
    // Under a file whose name matched, its nested files all show; else only those on the way to a hit.
    const nested = f && !hit?.ranges.length ? entry.nested.filter(keepFile) : entry.nested;
    const lines = hit?.lines || [];
    return new Item('file', label(entry.name, hit), nested.length || lines.length ? (f ? EXPANDED : COLLAPSED) : NONE, {
      id: `${parentId}/${entry.name}`, resourceUri: vscode.Uri.file(full), contextValue: 'file', nested, lines, filter: f,
      command: { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(full)] },
    });
  }
}

// A name the search matched, its matches highlighted.
const label = (name, hit) => (hit?.ranges.length ? { label: name, highlights: hit.ranges } : name);

function countProjectsKept(node, kept) {
  return node.projects.some(kept) || node.folders.some((x) => countProjectsKept(x, kept));
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

/** A folder profile written as VS writes one (FolderProfile, FolderProfile1… while the name is taken); its name, or
 *  undefined when no folder is given. */
async function newPublishProfile(projectFile, dir, taken, folder) {
  const framework = readProject(projectFile).frameworks[0] || '';
  folder ??= await vscode.window.showInputBox({ title: t('Folder location'), prompt: t('Enter the path of a local or network folder'),
    value: `bin\\Release\\${framework}\\publish\\` });
  if (!folder) return undefined;
  let name = 'FolderProfile';
  for (let n = 1; taken.includes(name); n++) name = `FolderProfile${n}`;
  const xml = (s) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.pubxml`), `<?xml version="1.0" encoding="utf-8"?>
<!--
https://go.microsoft.com/fwlink/?LinkID=208121.
-->
<Project>
  <PropertyGroup>
    <DeleteExistingFiles>false</DeleteExistingFiles>
    <ExcludeApp_Data>false</ExcludeApp_Data>
    <LaunchSiteAfterPublish>true</LaunchSiteAfterPublish>
    <LastUsedBuildConfiguration>Release</LastUsedBuildConfiguration>
    <LastUsedPlatform>Any CPU</LastUsedPlatform>
    <PublishProvider>FileSystem</PublishProvider>
    <PublishUrl>${xml(folder)}</PublishUrl>
    <PublishDir>${xml(folder)}</PublishDir>
    <WebPublishMethod>FileSystem</WebPublishMethod>
    <_TargetId>Folder</_TargetId>${framework ? `\n    <TargetFramework>${framework}</TargetFramework>` : ''}
  </PropertyGroup>
</Project>
`.replace(/\n/g, '\r\n'));
  return name;
}

/** Where a publish with a profile lands, as MSBuild evaluates it (a relative folder is the project's). */
function publishDir(projectFile, configuration, profile, framework) {
  return new Promise((resolve) => {
    require('child_process').execFile('dotnet', ['msbuild', projectFile, '-getProperty:PublishDir', `-p:Configuration=${configuration}`, `-p:PublishProfile=${profile}`,
      ...(framework ? [`-p:TargetFramework=${framework}`] : [])],
      { cwd: path.dirname(projectFile), windowsHide: true }, (error, stdout) => resolve(error ? undefined : path.resolve(path.dirname(projectFile), stdout.trim())));
  });
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

  // A dotnet command in a task (a command line, or dotnet's arguments, each quoted for the shell); resolves with its exit
  // code once it ends.
  const terminalTask = async (name, cmd, cwd, started = () => {}) => {
    const shell = typeof cmd === 'string' ? new vscode.ShellExecution(cmd, { cwd })
      : new vscode.ShellExecution('dotnet', cmd.map((value) => ({ value, quoting: vscode.ShellQuoting.Strong })), { cwd });
    const execution = await vscode.tasks.executeTask(new vscode.Task({ type: 'shell', task: name }, vscode.TaskScope.Workspace, name, 'CSharpShooter', shell));
    started(execution);
    return new Promise((resolve) => {
      const done = vscode.tasks.onDidEndTaskProcess((e) => e.execution === execution && (done.dispose(), resolve(e.exitCode)));
    });
  };
  // A build in a task, what it does said at the bottom right as F5's build says it, and its outcome in the status bar as VS's.
  const { launchProgress, buildLog, followBuildLog } = require('./build-progress');
  // `args`: dotnet's, quoted one by one, so the file logger's ';' never ends the shell's command (PowerShell's would).
  const buildTask = async (name, args, cwd) => {
    const progress = launchProgress(name);
    const log = buildLog();
    const following = followBuildLog(log.file, progress.report);
    progress.report(t('Build started…'));
    try {
      const code = await terminalTask(name, [...args, log.arg], cwd, (execution) => progress.token.onCancellationRequested(() => execution.terminate()));
      vscode.window.setStatusBarMessage(code === 0 ? t('Build succeeded') : t('Build failed'), 10000);
      return code;
    } finally {
      following.stop();
      progress.done();
    }
  };
  // A build with the Task Runner's bindings around it (csharpShooter.taskRunner.buildBindings): a solution's are all of them.
  const { buildBindings } = require('./task-runner');
  const bound = async (item, before, run, after) => {
    const folder = item.kind === 'project' ? path.dirname(item.file) : undefined;
    if (!(await buildBindings(before, folder))) return;
    if ((await run()) === 0 && after) await buildBindings(after, folder);
  };
  const target = (item) => item.file; // the .sln or the project file
  // The status bar's solution configuration and platform, as the .sln maps them for a project (VS builds with them).
  const settings = async (item) => (provider.startup ? require('./startup').buildArgs(await provider.startup.buildSettings(target(item))) : []);
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('csharpShooter.solution.refresh', () => provider.refresh());
  register('csharpShooter.solution.build', (item) => bound(item, 'BeforeBuild', async () => buildTask(`build ${item.label}`, ['build', target(item), ...(await settings(item))], path.dirname(target(item))), 'AfterBuild'));
  register('csharpShooter.solution.rebuild', (item) => bound(item, 'BeforeBuild', async () => buildTask(`rebuild ${item.label}`, ['build', '--no-incremental', target(item), ...(await settings(item))], path.dirname(target(item))), 'AfterBuild'));
  register('csharpShooter.solution.clean', (item) => bound(item, 'Clean', () => terminalTask(`clean ${item.label}`, `dotnet clean "${target(item)}"`, path.dirname(target(item)))));
  // Opublikuj, as VS's folder publish: a profile of the project's (Properties/PublishProfiles/*.pubxml) or a new one, then
  // dotnet publish with it. The configuration is given on the command line (the SDK does not take it from a profile, as
  // Passenger notes) and the folder is said as MSBuild resolves it. `choice` (the tests'): a profile's name, or { folder }.
  register('csharpShooter.solution.publish', async (item, choice) => {
    const project = path.dirname(item.file);
    const dir = path.join(project, 'Properties', 'PublishProfiles');
    const profiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.pubxml')).map((f) => path.basename(f, '.pubxml')) : [];
    const read = (name, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(fs.readFileSync(path.join(dir, `${name}.pubxml`), 'utf8'))?.[1];
    let profile = typeof choice === 'string' ? choice : undefined;
    if (!profile) {
      const NEW = t('New profile');
      const picked = choice?.folder ? NEW : (await vscode.window.showQuickPick([
        ...profiles.map((p) => ({ label: p, description: read(p, 'PublishUrl') || read(p, 'PublishDir') || '', detail: read(p, 'LastUsedBuildConfiguration') })),
        { label: NEW, description: 'Folder' }], { title: t('Publish: {0}', item.label), placeHolder: t('Target') }))?.label;
      if (!picked) return undefined;
      profile = picked === NEW ? await newPublishProfile(item.file, dir, profiles, choice?.folder) : picked;
      if (!profile) return undefined;
    }
    const configuration = read(profile, 'LastUsedBuildConfiguration') || 'Release';
    // A multi-targeted project's outer build reads no TargetFramework from the profile either (NETSDK1129 without -f).
    const framework = read(profile, 'TargetFramework');
    if (!(await buildBindings('BeforeBuild', project))) return undefined;
    const code = await buildTask(`publish ${item.label} (${profile})`,
      ['publish', item.file, '-c', configuration, ...(framework ? ['-f', framework] : []), `-p:PublishProfile=${profile}`], project);
    let folder;
    if (code === 0) {
      await buildBindings('AfterBuild', project);
      folder = await publishDir(item.file, configuration, profile, framework);
      vscode.window.showInformationMessage(`${t('Publish succeeded.')} ${folder || ''}`, t('Open folder'))
        .then((b) => b && folder && vscode.env.openExternal(vscode.Uri.file(folder)));
    } else {
      vscode.window.showErrorMessage(t('Publish failed.'));
    }
    return { code, profile, folder };
  });
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

module.exports = { registerSolutionView, readSolution, readProject, nestingParents, newPublishProfile };
