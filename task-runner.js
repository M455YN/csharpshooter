// Task Runner Explorer, after Visual Studio's: each gulpfile's tasks and each package.json's scripts, run and stopped from
// the tree, and the gulpfile's bindings (the "/// <binding ... />" line VS writes): Project Open runs as the solution
// opens, Before Build, After Build and Clean around CSharpShooter's builds when csharpShooter.taskRunner.buildBindings is on.
const vscode = require('vscode');
const { t, n_, table } = require('./l10n');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// Labels as Visual Studio's Task Runner Explorer has them (its Resources and Resources.pl), in English and Polish.
const T = table({
  view: 'Task Runner Explorer',
  tasks: 'Tasks',
  bindings: 'Bindings',
  noTasks: '(No tasks found)',
  running: 'running',
  started: 'Task Runner Explorer is starting the task "{0}"...',
  ended: 'Task ended',
  exited: 'Task {0} exited with exit code {1}',
  listFailed: 'Failed to run "{0}"...',
  leftToTasksJson: 'tasks.json already starts {0} as the folder opens ("{1}"), so the Project Open binding leaves it out.',
});
const BINDINGS = [['BeforeBuild', n_('Before Build')], ['AfterBuild', n_('After Build')], ['Clean', n_('Clean')], ['ProjectOpened', n_('Project Open')]];
const BINDING_LINE = /^(\uFEFF?)\/\/\/\s*<binding\b([^>]*?)\/>[^\r\n]*(\r?\n|$)/;
const ATTRIBUTE = /(\w+)\s*=\s*'([^']*)'/g;

const setting = (name) => vscode.workspace.getConfiguration('csharpShooter.taskRunner').get(name);

/** The bindings of a gulpfile's first line, as { BeforeBuild: ['task', ...], ... }, in the order the line has them. */
function readBindings(text) {
  const m = BINDING_LINE.exec(text);
  const out = {};
  if (m) for (const [, name, list] of m[2].matchAll(ATTRIBUTE)) out[name] = list.split(',').map((t) => t.trim()).filter(Boolean);
  return out;
}

/** The gulpfile with its binding line rewritten (dropped when no task is bound), its BOM and line endings kept. */
function writeBindings(text, bindings) {
  const m = BINDING_LINE.exec(text);
  const bom = m ? m[1] : text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = m ? text.slice(m[0].length) : text.replace(/^\uFEFF/, '');
  const eol = (m && m[3]) || (text.includes('\r\n') ? '\r\n' : '\n');
  const attrs = Object.entries(bindings).filter(([, tasks]) => tasks.length).map(([name, tasks]) => `${name}='${tasks.join(', ')}'`);
  return bom + (attrs.length ? `/// <binding ${attrs.join(' ')} />${eol}` : '') + body;
}

/** The environment a folder's tools run in: its node_modules\.bin first on PATH, as VS puts it (External Web Tools). */
function toolsEnv(dir) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { [key]: [path.join(dir, 'node_modules', '.bin'), process.env[key]].filter(Boolean).join(path.delimiter) };
}

/** gulp's own list of a gulpfile's tasks (--tasks-simple), through the folder's gulp, else npx's. */
function gulpTasks(file) {
  const dir = path.dirname(file);
  const local = path.join(dir, 'node_modules', 'gulp', 'bin', 'gulp.js');
  const [cmd, args] = fs.existsSync(local) ? ['node', [local]] : ['npx', ['--no-install', 'gulp']];
  return new Promise((resolve) => {
    execFile(cmd, [...args, '--tasks-simple', '--gulpfile', file, '--cwd', dir], { cwd: dir, windowsHide: true, shell: cmd === 'npx', timeout: 60000,
      env: { ...process.env, ...toolsEnv(dir) } },
    (error, stdout, stderr) => resolve(error ? { error: (stderr || error.message).trim().split(/\r?\n/)[0] } : { tasks: stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) }));
  });
}

/** A task's command as one line: a shell command line, or its command (process) and arguments. */
function commandText(exec) {
  if (!exec) return '';
  const word = (a) => (typeof a === 'string' ? a : a?.value ?? '');
  return exec.commandLine ?? [word(exec.command ?? exec.process), ...(exec.args || []).map(word)].join(' ');
}

/** A task's folder: its cwd with ${workspaceFolder} put in, else the folder it belongs to. */
function folderOf(cwd, scopeFolder) {
  const base = scopeFolder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return path.resolve(base, (cwd || '.').replace(/\$\{workspaceFolder(?::[^}]*)?\}/g, base)).toLowerCase();
}

/** Whether a command run in a folder is gulp running this task of this gulpfile (`npx gulp watchFiles_X` in its folder,
 *  or with --gulpfile naming it): how a tasks.json task and a Task Runner task are known to be the same. */
function runsGulpTask(command, folder, file, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /\bgulp(\.js)?\b/.test(command) && new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(command)
    && (folder === path.dirname(file).toLowerCase() || command.toLowerCase().includes(file.toLowerCase()));
}

function npmScripts(file) {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).scripts || {});
  } catch {
    return [];
  }
}

class Node extends vscode.TreeItem {
  constructor(kind, label, collapsible, extra = {}) {
    super(label, collapsible);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const icon = (name, color) => new vscode.ThemeIcon(name, color ? new vscode.ThemeColor(color) : undefined);
const COLLAPSED = vscode.TreeItemCollapsibleState.Collapsed;
const EXPANDED = vscode.TreeItemCollapsibleState.Expanded;
const NONE = vscode.TreeItemCollapsibleState.None;

/** The folders of a solution's projects, and the solution's own: where VS's Task Runner Explorer looks. */
function solutionFolders(file) {
  const { readSolution } = require('./solution');
  const walk = (node) => [...node.projects.map((p) => path.dirname(p)), ...node.folders.flatMap(walk)];
  return new Set([path.dirname(file), ...walk(readSolution(file))].map((d) => d.toLowerCase()));
}

class TaskRunner {
  constructor(findSolution) {
    this.findSolution = findSolution;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.cache = new Map(); // gulpfile -> { mtime, result }
    this.running = new Map(); // `${file}|${task}` -> TaskExecution
    this.output = vscode.window.createOutputChannel(T.view);
    this.lastExit = undefined; // { task, code }: what the tests read
  }

  refresh() {
    this.changed.fire();
  }

  getTreeItem(node) {
    return node;
  }

  /** The runner files: gulpfiles and package.json files that have scripts, in the solution's project folders (all of the
   *  workspace's without a solution), node_modules left out. */
  async files() {
    const solution = await this.findSolution();
    const folders = solution ? solutionFolders(solution) : null;
    const within = (u) => !folders || folders.has(path.dirname(u.fsPath).toLowerCase());
    const gulp = (await vscode.workspace.findFiles('**/[gG]ulpfile.{js,mjs,cjs}', '**/node_modules/**')).filter(within);
    const npm = (await vscode.workspace.findFiles('**/package.json', '**/node_modules/**')).filter((u) => within(u) && npmScripts(u.fsPath).length);
    return [...gulp.map((u) => ({ kind: 'gulp', file: u.fsPath })), ...npm.map((u) => ({ kind: 'npm', file: u.fsPath }))]
      .sort((a, b) => path.dirname(a.file).localeCompare(path.dirname(b.file)) || a.kind.localeCompare(b.kind));
  }

  async tasksOf(file) {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = this.cache.get(file);
    if (hit && hit.mtime === mtime) return hit.result;
    const result = await gulpTasks(file);
    this.cache.set(file, { mtime, result });
    return result;
  }

  async getChildren(node) {
    if (!node) {
      return (await this.files()).map(({ kind, file }) => new Node(kind === 'gulp' ? 'gulpfile' : 'packageJson',
        `${path.basename(file)}`, EXPANDED, {
          id: `tr:${file}`, file, description: path.basename(path.dirname(file)), resourceUri: vscode.Uri.file(file), tooltip: file,
          iconPath: kind === 'gulp' ? icon('symbol-event', 'charts.red') : icon('package', 'charts.green'),
          contextValue: kind === 'gulp' ? 'trGulpfile' : 'trPackageJson',
        }));
    }
    if (node.kind === 'gulpfile') {
      return [
        new Node('tasksGroup', T.tasks, EXPANDED, { id: `${node.id}#tasks`, file: node.file, iconPath: icon('checklist') }),
        new Node('bindingsGroup', T.bindings, COLLAPSED, { id: `${node.id}#bindings`, file: node.file, iconPath: icon('link') }),
      ];
    }
    if (node.kind === 'packageJson') {
      return npmScripts(node.file).map((s) => this.taskNode('script', node.file, s, `${node.id}/${s}`));
    }
    if (node.kind === 'tasksGroup') {
      const result = await this.tasksOf(node.file);
      if (result.error) {
        return [new Node('error', T.listFailed(path.basename(node.file)), NONE, { id: `${node.id}/error`, tooltip: result.error, description: result.error, iconPath: icon('warning', 'charts.yellow') })];
      }
      if (!result.tasks.length) return [new Node('none', T.noTasks, NONE, { id: `${node.id}/none` })];
      const bound = readBindings(fs.readFileSync(node.file, 'utf8'));
      return result.tasks.map((t) => this.taskNode('task', node.file, t, `${node.id}/${t}`, bound));
    }
    if (node.kind === 'bindingsGroup') {
      const bound = readBindings(fs.readFileSync(node.file, 'utf8'));
      return BINDINGS.map(([name, label]) => new Node('binding', `${t(label)} (${(bound[name] || []).length})`, (bound[name] || []).length ? EXPANDED : NONE, {
        id: `${node.id}/${name}`, file: node.file, binding: name, tasks: bound[name] || [], iconPath: icon('symbol-event'),
      }));
    }
    if (node.kind === 'binding') {
      return node.tasks.map((t, i) => this.taskNode('bound', node.file, t, `${node.id}/${t}`, undefined,
        { binding: node.binding, first: i === 0, last: i === node.tasks.length - 1 }));
    }
    return [];
  }

  /** A task's row. Its contextValue says what the menus offer: "trTask", "trScript" or "trBound", ".running" while it
   *  runs, " b:<Event>" per binding it is in (the Bindings menu's checks), " up"/" down" where a bound task can move. */
  /** A run of a gulp task this panel did not start: tasks.json's (runOn: folderOpen, Run Task) or another extension's. */
  otherRun(file, name) {
    const ours = new Set(this.running.values());
    return vscode.tasks.taskExecutions.find((e) => !ours.has(e) && runsGulpTask(commandText(e.task.execution),
      folderOf(e.task.execution?.options?.cwd, e.task.scope?.uri?.fsPath), file, name));
  }

  /** tasks.json's tasks that VS Code starts as the folder opens and that run this gulp task, when it starts them at all
   *  (task.allowAutomaticTasks not off): Project Open leaves those to it, so a watcher never runs twice. */
  startedByTasksJson(file, name) {
    if (vscode.workspace.getConfiguration('task').get('allowAutomaticTasks') === 'off') return undefined;
    for (const folder of vscode.workspace.workspaceFolders || []) {
      for (const t of vscode.workspace.getConfiguration('tasks', folder.uri).get('tasks') || []) {
        if (t.runOptions?.runOn !== 'folderOpen') continue;
        const command = [t.command, ...(t.args || []).map((a) => (typeof a === 'string' ? a : a.value))].join(' ');
        if (runsGulpTask(command, folderOf(t.options?.cwd, folder.uri.fsPath), file, name)) return t.label || command;
      }
    }
    return undefined;
  }

  taskNode(kind, file, name, id, bound, place) {
    const running = this.running.has(`${file}|${name}`) || !!this.otherRun(file, name);
    const flags = [
      ...Object.entries(bound || {}).filter(([, tasks]) => tasks.includes(name)).map(([event]) => `b:${event}`),
      ...(place && !place.first ? ['up'] : []), ...(place && !place.last ? ['down'] : []),
    ];
    const base = kind === 'script' ? 'trScript' : kind === 'bound' ? 'trBound' : 'trTask';
    return new Node(kind === 'bound' ? 'task' : kind, name, NONE, {
      id, file, task: name, binding: place?.binding, description: running ? T.running : undefined, tooltip: `${kind === 'script' ? 'npm run' : 'gulp'} ${name}`,
      iconPath: running ? icon('sync~spin', 'charts.green') : icon(kind === 'script' ? 'terminal' : 'symbol-method', kind === 'script' ? undefined : 'charts.purple'),
      contextValue: [`${base}${running ? '.running' : ''}`, ...flags].join(' '),
    });
  }

  /** Runs a task in a terminal of its own; resolves once it ends (a watch task: when stopped), with its exit code. */
  async run(file, name, kind = 'task') {
    const key = `${file}|${name}`;
    if (this.running.has(key) || this.otherRun(file, name)) return undefined; // one run of a task at a time, whoever started it
    const dir = path.dirname(file);
    const local = path.join(dir, 'node_modules', 'gulp', 'bin', 'gulp.js');
    // As VS runs it: node_modules\.bin first on PATH, gulp with --color (its terminal shows the colours).
    const options = { cwd: dir, env: toolsEnv(dir) };
    const exec = kind === 'script' ? new vscode.ShellExecution('npm', ['run', name], options)
      : fs.existsSync(local) ? new vscode.ProcessExecution('node', [local, name, '--color', '--gulpfile', file], options)
        : new vscode.ShellExecution('npx', ['gulp', name, '--color', '--gulpfile', file], options);
    const label = `${name} (${path.basename(dir)})`;
    const task = new vscode.Task({ type: 'shell', task: label }, vscode.TaskScope.Workspace, label, 'Task Runner', exec);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated };
    task.isBackground = /watch/i.test(name);
    const execution = await vscode.tasks.executeTask(task);
    this.running.set(key, execution);
    this.refresh();
    // While it starts, as VS says it: once its process runs (a watcher runs on for good), the message goes.
    const status = vscode.window.setStatusBarMessage(`$(sync~spin) ${T.started(name)}`, 30000);
    const started = vscode.tasks.onDidStartTaskProcess((e) => e.execution === execution && (started.dispose(), status.dispose()));
    return new Promise((resolve) => {
      const done = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution !== execution) return;
        done.dispose();
        started.dispose();
        status.dispose();
        this.running.delete(key);
        this.refresh();
        // As VS's console ends a run: the task and its exit code, in the Task Runner's output; the status bar says so.
        this.lastExit = { task: name, code: e.exitCode };
        this.output.appendLine(`${new Date().toLocaleTimeString()} ${T.exited(label, e.exitCode ?? '?')}`);
        vscode.window.setStatusBarMessage(T.ended, 5000);
        resolve(e.exitCode);
      });
    });
  }

  stop(file, name) {
    (this.running.get(`${file}|${name}`) ?? this.otherRun(file, name))?.terminate();
  }

  /** Bound tasks of the gulpfiles in a folder (a project's) or everywhere: started, and for a build's bindings awaited,
   *  each in the line's order, as VS runs them. A failed one stops the build's. */
  async runBindings(binding, folder, wait = true) {
    const files = (await this.files()).filter((f) => f.kind === 'gulp' && (!folder || path.dirname(f.file).toLowerCase() === folder.toLowerCase()));
    for (const { file } of files) {
      for (const task of readBindings(fs.readFileSync(file, 'utf8'))[binding] || []) {
        const byTasksJson = binding === 'ProjectOpened' && this.startedByTasksJson(file, task);
        if (byTasksJson) {
          this.output.appendLine(T.leftToTasksJson(`${task} (${path.basename(path.dirname(file))})`, byTasksJson));
          continue;
        }
        const ended = this.run(file, task);
        if (wait && (await ended) !== 0) return false;
      }
    }
    return true;
  }

  toggleBinding(file, binding, task) {
    const text = fs.readFileSync(file, 'utf8');
    const bound = readBindings(text);
    const list = bound[binding] || [];
    bound[binding] = list.includes(task) ? list.filter((t) => t !== task) : [...list, task];
    fs.writeFileSync(file, writeBindings(text, bound));
    this.refresh();
  }

  /** A bound task one place up (-1) or down (+1) in its event's list, or out of it (0): VS's Bindings tab buttons. */
  moveBinding(file, binding, task, delta) {
    const text = fs.readFileSync(file, 'utf8');
    const bound = readBindings(text);
    const list = [...(bound[binding] || [])];
    const at = list.indexOf(task);
    if (at < 0) return;
    if (delta === 0) list.splice(at, 1);
    else if (list[at + delta] !== undefined) [list[at], list[at + delta]] = [list[at + delta], list[at]];
    bound[binding] = list;
    fs.writeFileSync(file, writeBindings(text, bound));
    this.refresh();
  }
}

let runner;

function registerTaskRunner(context, findSolution) {
  runner = new TaskRunner(findSolution);
  const view = vscode.window.createTreeView('csharpShooter.taskRunner', { treeDataProvider: runner, showCollapseAll: true });
  context.subscriptions.push(view);
  const watcher = vscode.workspace.createFileSystemWatcher('**/{[gG]ulpfile.{js,mjs,cjs},package.json}');
  for (const ev of [watcher.onDidCreate, watcher.onDidDelete, watcher.onDidChange]) ev((u) => !/node_modules/.test(u.fsPath) && runner.refresh());
  context.subscriptions.push(watcher);

  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('csharpShooter.taskRunner.refresh', () => {
    runner.cache.clear();
    runner.refresh();
  });
  register('csharpShooter.taskRunner.run', (node) => runner.run(node.file, node.task, node.kind));
  register('csharpShooter.taskRunner.stop', (node) => runner.stop(node.file, node.task));
  for (const [name] of BINDINGS) register(`csharpShooter.taskRunner.bind${name}`, (node) => runner.toggleBinding(node.file, name, node.task));
  register('csharpShooter.taskRunner.moveUp', (node) => runner.moveBinding(node.file, node.binding, node.task, -1));
  register('csharpShooter.taskRunner.moveDown', (node) => runner.moveBinding(node.file, node.binding, node.task, 1));
  register('csharpShooter.taskRunner.removeBinding', (node) => runner.moveBinding(node.file, node.binding, node.task, 0));
  context.subscriptions.push(runner.output);
  // A run started elsewhere (tasks.json) shows as running here, and stops from here, so the tree follows every start and end.
  context.subscriptions.push(vscode.tasks.onDidStartTask(() => runner.refresh()), vscode.tasks.onDidEndTask(() => runner.refresh()));

  // Project Open: the bound tasks start as the solution opens (the watchers, mostly), as VS starts them.
  if (setting('projectOpenBindings')) runner.runBindings('ProjectOpened', undefined, false);
  return { runner, view, readBindings, writeBindings };
}

/** For builds: Before Build / After Build / Clean bindings of a project folder's gulpfiles, when buildBindings is on. */
async function buildBindings(binding, projectDir) {
  if (!runner || !setting('buildBindings')) return true;
  return runner.runBindings(binding, projectDir, true);
}

module.exports = { registerTaskRunner, buildBindings, readBindings, writeBindings };
