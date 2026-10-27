// Task Runner Explorer, after Visual Studio's: a tool window in the bottom panel (VS registers it Tabbed with the Output
// window, Orientation Bottom). On the left each gulpfile's tasks and each package.json's scripts, run and stopped from the
// tree; on the right tabs: Bindings (the "/// <binding ... />" line VS writes) and a console per task run, which shows what
// VS's does: "<folder>> cmd.exe /c gulp -b ... --color --gulpfile ... <task>" and the task's coloured output. Project Open
// runs as the solution opens, Before Build, After Build and Clean around CSharpShooter's builds when
// csharpShooter.taskRunner.buildBindings is on.
const vscode = require('vscode');
const { t, n_, table } = require('./l10n');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

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
  tabRunning: '{0} (running)',
  terminated: 'Process terminated with code {0}.',
  closeConsole: 'Close Console',
  terminateQuestion: 'This process has not exited. Do you want to terminate it?',
  terminate: 'Terminate',
  close: 'Close',
  moveUp: 'Move Up',
  moveDown: 'Move Down',
  remove: 'Remove',
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
    this.consoles = new Map(); // `${file}|${task}` -> the console tab of its last run: { key, task, cwd, commandLine, env, text, running, code }
    this.selected = undefined; // the gulpfile the Bindings tab shows: the tree's selection's, else the first
    this.tabs = new ConsoleView(this);
    this.output = vscode.window.createOutputChannel(T.view);
    this.lastExit = undefined; // { task, code }: what the tests read
  }

  refresh() {
    this.changed.fire();
    this.tabs.update();
  }

  /** A gulpfile's events as VS's Bindings tab lists them, each with its bound tasks (getChildren gives their rows). */
  bindingEvents(file) {
    const bound = readBindings(fs.readFileSync(file, 'utf8'));
    return BINDINGS.map(([name, label]) => new Node('binding', `${t(label)} (${(bound[name] || []).length})`, (bound[name] || []).length ? EXPANDED : NONE, {
      id: `tr:${file}#bindings/${name}`, file, binding: name, tasks: bound[name] || [], iconPath: icon('symbol-event'),
    }));
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
      const files = await this.files();
      if (!files.some((f) => f.file === this.selected)) {
        this.selected = files.find((f) => f.kind === 'gulp')?.file;
        this.tabs.update();
      }
      return files.map(({ kind, file }) => new Node(kind === 'gulp' ? 'gulpfile' : 'packageJson',
        `${path.basename(file)}`, EXPANDED, {
          id: `tr:${file}`, file, description: path.basename(path.dirname(file)), resourceUri: vscode.Uri.file(file), tooltip: file,
          iconPath: kind === 'gulp' ? icon('symbol-event', 'charts.red') : icon('package', 'charts.green'),
          contextValue: kind === 'gulp' ? 'trGulpfile' : 'trPackageJson',
        }));
    }
    // As VS's tree: the gulpfile, its Tasks; its bindings are the Bindings tab's (bindingEvents).
    if (node.kind === 'gulpfile') {
      return [new Node('tasksGroup', T.tasks, EXPANDED, { id: `${node.id}#tasks`, file: node.file, iconPath: icon('checklist') })];
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

  /** Runs a task as VS does, its output in a console tab of its own (and in the task's terminal); resolves once it ends
   *  (a watch task: when stopped), with its exit code. */
  async run(file, name, kind = 'task') {
    const key = `${file}|${name}`;
    if (this.running.has(key) || this.otherRun(file, name)) return undefined; // one run of a task at a time, whoever started it
    const dir = path.dirname(file);
    // VS's command line (its gulp task runner's "/c gulp -b \"{0}\" --color --gulpfile \"{1}\" {2}", through cmd.exe), with
    // node_modules\.bin first on PATH; the gulpfile's path with forward slashes, as VS gives it.
    const args = kind === 'script' ? `npm run ${name}` : `gulp -b "${dir}" --color --gulpfile "${file.replace(/\\/g, '/')}" ${name}`;
    const [shell, shellArgs] = process.platform === 'win32' ? ['cmd.exe', ['/c', args]] : ['sh', ['-c', args]];
    const env = { ...process.env, ...toolsEnv(dir) };
    const tab = { key, file, task: name, cwd: dir, commandLine: `${shell} ${shellArgs.join(' ')}`, env, text: '', running: true, code: undefined };
    const print = (text) => {
      tab.text = (tab.text + text).slice(-500000);
      this.tabs.append(key, text);
    };
    this.consoles.delete(key); // a run again: its tab comes last, as a new one
    this.consoles.set(key, tab);
    print(`${dir}> ${tab.commandLine}\r\n`); // as VS's console starts: "{0}> {1}"

    let ended;
    const exited = new Promise((resolve) => (ended = resolve));
    const write = new vscode.EventEmitter();
    const closed = new vscode.EventEmitter();
    const pty = {
      onDidWrite: write.event,
      onDidClose: closed.event,
      open: () => {
        const child = spawn(shell, shellArgs, { cwd: dir, env, windowsHide: true, windowsVerbatimArguments: true });
        tab.child = child;
        const out = (data) => {
          const text = data.toString().replace(/(?<!\r)\n/g, '\r\n');
          print(text);
          write.fire(text);
        };
        child.stdout.on('data', out);
        child.stderr.on('data', out);
        child.on('error', (e) => out(`${e.message}\n`));
        child.on('close', (code) => {
          out(`${tab.stopped ? T.terminated(code ?? 1) : T.exited(name, code ?? '?')}\n`);
          closed.fire(code ?? 1);
          ended(code ?? 1);
        });
      },
      close: () => this.kill(tab),
    };
    const label = `${name} (${path.basename(dir)})`;
    const task = new vscode.Task({ type: 'shell', task: label }, vscode.TaskScope.Workspace, label, 'Task Runner', new vscode.CustomExecution(async () => pty));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Never, panel: vscode.TaskPanelKind.Dedicated };
    task.isBackground = /watch/i.test(name);
    const execution = await vscode.tasks.executeTask(task);
    this.running.set(key, execution);
    this.refresh();
    this.tabs.select(key);
    // While it starts, as VS says it; a moment later the message goes (a watcher runs on for good).
    const status = vscode.window.setStatusBarMessage(`$(sync~spin) ${T.started(name)}`, 3000);
    const code = await exited;
    status.dispose();
    tab.running = false;
    tab.code = code;
    tab.child = undefined;
    this.running.delete(key);
    this.refresh();
    // As VS's console ends a run: the task and its exit code, in the Task Runner's output; the status bar says so.
    this.lastExit = { task: name, code };
    this.output.appendLine(`${new Date().toLocaleTimeString()} ${T.exited(label, code)}`);
    vscode.window.setStatusBarMessage(T.ended, 5000);
    return code;
  }

  /** Stops a run with its whole process tree, as VS does (taskkill /F /T /PID). */
  kill(tab) {
    if (!tab.child || tab.child.exitCode !== null) return;
    tab.stopped = true;
    if (process.platform === 'win32') execFile('taskkill', ['/F', '/T', '/PID', String(tab.child.pid)], { windowsHide: true }, () => {});
    else tab.child.kill();
  }

  stop(file, name) {
    const key = `${file}|${name}`;
    const tab = this.consoles.get(key);
    if (tab?.running) return this.kill(tab);
    (this.running.get(key) ?? this.otherRun(file, name))?.terminate();
  }

  /** A console tab's ×: a run still going is asked about first ("Close Console"), as VS asks, and stopped. */
  async closeTab(key) {
    const tab = this.consoles.get(key);
    if (!tab) return;
    if (tab.running) {
      const answer = await vscode.window.showWarningMessage(T.closeConsole, { modal: true, detail: T.terminateQuestion }, T.terminate);
      if (answer !== T.terminate) return;
      this.kill(tab);
    }
    this.consoles.delete(key);
    this.tabs.update();
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

/** The right half of VS's tool window: the Bindings tab (the selected gulpfile's events and bound tasks, moved and
 *  removed from there) and a console tab per task run, "{0} (running)" while it runs, closed with its ×. */
class ConsoleView {
  constructor(runner) {
    this.runner = runner;
    this.webview = undefined;
    this.current = 'bindings'; // the tab shown: 'bindings' or a console's key
  }

  /** What it shows (the tests read it). */
  state() {
    const { consoles, selected } = this.runner;
    if (this.current !== 'bindings' && !consoles.has(this.current)) this.current = 'bindings';
    const events = selected && fs.existsSync(selected) ? this.runner.bindingEvents(selected) : [];
    return {
      type: 'state', current: this.current,
      labels: { bindings: T.bindings, close: T.close, moveUp: T.moveUp, moveDown: T.moveDown, remove: T.remove },
      file: selected, gulpfile: selected ? path.basename(selected) : '', folder: selected ? path.basename(path.dirname(selected)) : '',
      events: events.map((e) => ({ binding: e.binding, label: e.label, tasks: e.tasks })),
      tabs: [...consoles.values()].map((c) => ({ key: c.key, title: c.running ? T.tabRunning(c.task) : c.task, tooltip: `${c.cwd}> ${c.commandLine}` })),
    };
  }

  update() {
    this.webview?.postMessage(this.state());
  }

  append(key, text) {
    this.webview?.postMessage({ type: 'append', key, text });
  }

  select(key) {
    this.current = key;
    this.update();
  }

  resolveWebviewView(view) {
    this.webview = view.webview;
    view.webview.options = { enableScripts: true };
    view.onDidDispose(() => (this.webview = undefined));
    const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  #tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .tab { display: flex; align-items: center; gap: 4px; padding: 3px 8px; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; }
  .tab:hover { background: var(--vscode-list-hoverBackground); }
  .tab.on { border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder)); color: var(--vscode-panelTitle-activeForeground, inherit); }
  .x { border: 0; background: none; color: inherit; cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
  .x:hover { background: var(--vscode-toolbar-hoverBackground); }
  #body { flex: 1; overflow: auto; }
  .row { display: flex; align-items: center; padding: 1px 0; cursor: default; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .twisty { width: 16px; text-align: center; cursor: pointer; opacity: .8; }
  .event { font-weight: 600; } .count { margin-left: 4px; opacity: .8; font-weight: normal; }
  .gulp { color: var(--vscode-charts-red); margin-right: 4px; }
  .acts { margin-left: 12px; visibility: hidden; } .row:hover .acts { visibility: visible; }
  .acts button { border: 0; background: none; color: inherit; cursor: pointer; padding: 0 4px; }
  .acts button:hover { background: var(--vscode-toolbar-hoverBackground); }
  pre { margin: 0; padding: 2px 6px; min-height: 100%; box-sizing: border-box; white-space: pre-wrap; word-break: break-all;
    font: var(--vscode-editor-font-size, 13px) Consolas, var(--vscode-editor-font-family), monospace;
    background: var(--vscode-terminal-background, var(--vscode-panel-background)); color: var(--vscode-terminal-foreground, var(--vscode-foreground)); }
  .c30 { color: var(--vscode-terminal-ansiBlack); } .c31 { color: var(--vscode-terminal-ansiRed); } .c32 { color: var(--vscode-terminal-ansiGreen); }
  .c33 { color: var(--vscode-terminal-ansiYellow); } .c34 { color: var(--vscode-terminal-ansiBlue); } .c35 { color: var(--vscode-terminal-ansiMagenta); }
  .c36 { color: var(--vscode-terminal-ansiCyan); } .c37 { color: var(--vscode-terminal-ansiWhite); } .c90 { color: var(--vscode-terminal-ansiBrightBlack); }
  .c91 { color: var(--vscode-terminal-ansiBrightRed); } .c92 { color: var(--vscode-terminal-ansiBrightGreen); } .c93 { color: var(--vscode-terminal-ansiBrightYellow); }
  .c94 { color: var(--vscode-terminal-ansiBrightBlue); } .c95 { color: var(--vscode-terminal-ansiBrightMagenta); } .c96 { color: var(--vscode-terminal-ansiBrightCyan); }
  .c97 { color: var(--vscode-terminal-ansiBrightWhite); } .b { font-weight: bold; }
</style></head><body><div id="tabs"></div><div id="body"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  let state = { tabs: [], events: [], labels: {}, current: 'bindings' };
  const texts = {}; // console key -> its text, ANSI colours and all
  const collapsed = new Set();
  // The console's colours: SGR codes as spans (gulp's --color).
  const ansi = (text) => {
    let out = '', fg = '', bold = false;
    for (const part of text.replace(/\\r\\n/g, '\\n').split(/(\\x1b\\[[\\d;]*m)/)) {
      const m = /^\\x1b\\[([\\d;]*)m$/.exec(part);
      if (!m) {
        if (part) out += (fg || bold) ? '<span class="' + (fg ? 'c' + fg : '') + (bold ? ' b' : '') + '">' + esc(part) + '</span>' : esc(part);
        continue;
      }
      for (const c of (m[1] || '0').split(';').map(Number)) {
        if (c === 0) { fg = ''; bold = false; } else if (c === 1) bold = true; else if (c === 22) bold = false;
        else if (c === 39) fg = ''; else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = c;
      }
    }
    return out.replace(/\\x1b\\[[\\d;]*[A-Za-z]/g, '');
  };
  const renderTabs = () => {
    const tab = (key, title, tooltip, closable) => '<div class="tab' + (state.current === key ? ' on' : '') + '" data-key="' + esc(key) + '" title="' + esc(tooltip) + '">' + title +
      (closable ? '<button class="x" data-close="' + esc(key) + '" title="' + esc(state.labels.close) + '">\\u00d7</button>' : '') + '</div>';
    document.getElementById('tabs').innerHTML = tab('bindings', '\\u{1F517}\\uFE0E ' + esc(state.labels.bindings), state.labels.bindings, false) +
      state.tabs.map((t) => tab(t.key, esc(t.title), t.tooltip, true)).join('');
  };
  const renderBody = () => {
    const body = document.getElementById('body');
    if (state.current !== 'bindings') {
      const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
      body.innerHTML = '<pre>' + ansi(texts[state.current] || '') + '</pre>';
      if (atEnd) body.scrollTop = body.scrollHeight;
      return;
    }
    const L = state.labels;
    body.innerHTML = state.events.map((e) => {
      const open = e.tasks.length && !collapsed.has(e.binding);
      let html = '<div class="row event"><span class="twisty" data-toggle="' + e.binding + '">' + (e.tasks.length ? (open ? '\\u25e2' : '\\u25b7') : '') + '</span>' +
        esc(e.label.replace(/ \\(\\d+\\)$/, '')) + '<span class="count">(' + e.tasks.length + ')</span></div>';
      if (open) {
        html += '<div class="row" style="padding-left:16px"><span class="twisty">\\u25e2</span><span class="gulp">\\u25c6</span>' + esc(state.gulpfile) + '</div>';
        html += e.tasks.map((t, i) => '<div class="row" style="padding-left:48px">' + esc(t) + '<span class="acts">' +
          (i ? '<button data-move="-1" data-binding="' + e.binding + '" data-task="' + esc(t) + '" title="' + esc(L.moveUp) + '">\\u2191</button>' : '') +
          (i < e.tasks.length - 1 ? '<button data-move="1" data-binding="' + e.binding + '" data-task="' + esc(t) + '" title="' + esc(L.moveDown) + '">\\u2193</button>' : '') +
          '<button data-move="0" data-binding="' + e.binding + '" data-task="' + esc(t) + '" title="' + esc(L.remove) + '">\\u2715</button></span></div>').join('');
      }
      return html;
    }).join('');
  };
  let pending = false;
  const later = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderBody(); }); } };
  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return vscode.postMessage({ type: 'close', key: close.dataset.close });
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) { collapsed.has(toggle.dataset.toggle) ? collapsed.delete(toggle.dataset.toggle) : collapsed.add(toggle.dataset.toggle); return renderBody(); }
    const move = e.target.closest('[data-move]');
    if (move) return vscode.postMessage({ type: 'move', file: state.file, binding: move.dataset.binding, task: move.dataset.task, delta: +move.dataset.move });
    const tab = e.target.closest('.tab');
    if (tab) vscode.postMessage({ type: 'select', key: tab.dataset.key });
  });
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') { state = m; for (const k of Object.keys(texts)) if (!m.tabs.some((t) => t.key === k)) delete texts[k]; renderTabs(); renderBody(); }
    else if (m.type === 'text') { texts[m.key] = m.text; if (m.key === state.current) later(); }
    else if (m.type === 'append') { texts[m.key] = (texts[m.key] || '') + m.text; if (m.key === state.current) later(); }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') {
        this.update();
        for (const c of this.runner.consoles.values()) this.webview?.postMessage({ type: 'text', key: c.key, text: c.text });
      } else if (m.type === 'select') this.select(m.key);
      else if (m.type === 'close') this.runner.closeTab(m.key);
      else if (m.type === 'move' && m.file) this.runner.moveBinding(m.file, m.binding, m.task, m.delta);
    });
  }
}

let runner;

function registerTaskRunner(context, findSolution) {
  runner = new TaskRunner(findSolution);
  const view = vscode.window.createTreeView('csharpShooter.taskRunner', { treeDataProvider: runner, showCollapseAll: true });
  // The Bindings tab follows the tree: the gulpfile of the row selected, as VS's follows its project list.
  view.onDidChangeSelection(({ selection: [node] }) => {
    if (node?.file && /gulpfile\.[cm]?js$/i.test(node.file) && node.file !== runner.selected) {
      runner.selected = node.file;
      runner.tabs.update();
    }
  });
  context.subscriptions.push(view, vscode.window.registerWebviewViewProvider('csharpShooter.taskRunnerConsole', runner.tabs, { webviewOptions: { retainContextWhenHidden: true } }));
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

module.exports = { registerTaskRunner, buildBindings, readBindings, writeBindings, commandText };
