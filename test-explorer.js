// Visual Studio 2026's Test Explorer: the solution's test projects' tests as a tree (Projekt, przestrzeń nazw, klasa by
// default; or by class, namespace, project, state, duration), Uruchom wszystkie, Uruchom, Debuguj, Anuluj, Wyszukaj with
// VS's filters (Class:, Namespace:, Project:, State:, FullName:), the counts, and the Test Detail Summary under it (source,
// duration, message, stack trace with links, output). Tests are found in the built assemblies (vstest's list), run by
// `dotnet test` with a filter, and debugged by attaching to the test host that VSTEST_HOST_DEBUG makes wait.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { t, table } = require('./l10n');
const engine = require('./test-engine');
const { buildArgs } = require('./startup');
const { readSolution } = require('./solution');
const { projectOf } = require('./properties-window');

// VS's own words (its Test Explorer's resources, in English and Polish), l10n/pl.json.
const T = table({
  view: 'Test Explorer',
  details: 'Test Detail Summary',
  output: 'Tests',
  search: 'Search',
  empty: 'Build the solution to discover all available tests. Click "Run All" to build, discover and run all tests in the solution.',
  filtered: 'All tests are filtered out in this view.',
  none: 'No tests were found to run.',
  selectOne: 'Select a test to see more details',
  hierarchy: 'Project, Namespace, Class',
  'group.class': 'Class',
  'group.namespace': 'Namespace',
  'group.project': 'Project',
  'group.state': 'State',
  'group.duration': 'Duration',
  emptyNamespace: '<Empty namespace>',
  emptyClass: '<Empty class>',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
  notRun: 'Not Run',
  fast: 'Fast < 100 ms',
  medium: 'Medium > 100 ms',
  slow: 'Slow > 1 sec',
  slower: 'Slower > 15 s',
  slowest: 'Slowest > 30 s',
  source: 'Source',
  noSource: 'No source available',
  location: '{0} line {1}',
  duration: 'Duration',
  totalDuration: 'Total duration',
  message: 'Message',
  stack: 'Stack Trace',
  stdout: 'Standard Output',
  stderr: 'Standard Error',
  total: 'Total tests: {0}',
  passedCount: 'Passed: {0}',
  failedCount: 'Failed: {0}',
  skippedCount: 'Skipped: {0}',
  notRunCount: 'Not run: {0}',
  ms: '{0} ms',
  lessThanMs: '< 1 ms',
  seconds: '{0} s',
  minutes: '{0} min',
  startRun: '========== Starting test run ==========',
  startDebug: '** Starting the debugger **',
  endRun: '========== Test run finished: {0} tests run in {1} ({2} passed, {3} failed, {4} skipped) ==========',
  abortRun: '========== Test run cancelled: {0} tests run in {1} ({2} passed, {3} failed, {4} skipped) ==========',
  discovered: 'Found {0} tests in {1}',
  statusRun: 'Test run finished: {0} tests ({1} passed, {2} failed, {3} skipped)',
  running: 'A test run is in progress.',
  whileDebugging: 'Cannot run tests while debugging is in progress.',
  buildFailed: 'The build failed, so the tests were not run. See the Tests output for details.',
  noInContext: 'No tests were found at the cursor.',
  cannotAttach: 'The debugger could not attach to the test host.',
  filterPrompt: 'Filter the tests by name, or with Class:, Namespace:, Project:, State: or FullName: (a leading - leaves matches out)',
  groupPrompt: 'Group the tests by',
  notFound: 'Cannot go to the test "{0}".',
});

const STATES = { passed: 'passed', failed: 'failed', skipped: 'skipped', notrun: 'notRun' };
const ICONS = {
  passed: ['pass', 'testing.iconPassed'], failed: ['error', 'testing.iconFailed'], skipped: ['circle-slash', 'testing.iconSkipped'],
  notrun: ['circle-outline', 'testing.iconUnset'], queued: ['watch', 'testing.iconQueued'], running: ['sync~spin', 'testing.iconQueued'],
};
const icon = (key) => new vscode.ThemeIcon(ICONS[key][0], new vscode.ThemeColor(ICONS[key][1]));
const MODES = ['hierarchy', 'class', 'namespace', 'project', 'state', 'duration'];
const FILTER_STATE_WORDS = { passed: ['Powodzenie'], failed: ['Niepowodzenie'], skipped: ['Pominięto'], notrun: ['NotRun', 'Nie uruchomiono'] };

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const flatten = (node) => [...node.projects, ...node.folders.flatMap(flatten)];

/** "12 ms", "1.5 s", "2 min": a time as VS writes it. */
function formatDuration(ms) {
  if (ms < 1) return T.lessThanMs;
  if (ms < 1000) return T.ms(Math.round(ms));
  if (ms < 60000) return T.seconds((ms / 1000).toFixed(1));
  return T.minutes((ms / 60000).toFixed(1));
}

const label = (kind, value) => {
  if (kind === 'namespace') return T.emptyNamespace;
  if (kind === 'class') return T.emptyClass;
  if (kind === 'state') return T[STATES[value]];
  return value === 'none' ? T.notRun : T[value];
};

class TestExplorer {
  constructor(context, findSolution, startup) {
    this.context = context;
    this.findSolution = findSolution;
    this.startup = startup;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.projects = []; // { file, name, framework, dll, tests: [test] }
    this.tests = [];
    this.results = new Map(); // test key -> { outcome, duration, message, stack, stdout, stderr }
    this.mode = context.workspaceState.get('csharpShooter.tests.groupBy', 'hierarchy');
    this.filter = '';
    this.queued = new Set();
    this.active = new Set();
    this.runner = undefined; // { cancel } of the dotnet test going now
    this.cancelled = false;
    this.last = undefined; // { keys, debug }: what Repeat runs
    this.loaded = undefined;
    this.watchers = [];
    this.files = new Map(); // project -> .cs files (for Go to Test)
    this.output = vscode.window.createOutputChannel(T.output);
    this.nodes = new Map();
    this.roots = [];
  }

  // ---- finding tests -------------------------------------------------------------------------------------------

  /** The solution's test projects and the tests in their built assemblies, found again (a build is not run). */
  load() {
    this.loaded = this.discover();
    return this.loaded;
  }

  async discover(only) {
    const solution = await this.findSolution();
    const files = solution ? flatten(readSolution(solution)).filter((p) => /\.(cs|vb|fs)proj$/i.test(p) && fs.existsSync(p) && engine.isTestProject(p)) : [];
    const projects = files.map((file) => ({ file }));
    const previous = new Map(this.projects.map((p) => [p.file.toLowerCase(), p]));
    await Promise.all(projects.map(async (p) => {
      const old = previous.get(p.file.toLowerCase());
      if (old && only && !same(p.file, only)) return Object.assign(p, old); // only one project is looked at again
      p.name = path.basename(p.file, path.extname(p.file));
      const settings = await this.startup.buildSettings(p.file);
      const frameworks = (/<TargetFrameworks?>([^<]+)</.exec(fs.readFileSync(p.file, 'utf8'))?.[1] || '').split(';').map((f) => f.trim()).filter(Boolean);
      p.framework = frameworks.length > 1 ? frameworks[0] : undefined; // a multi-targeted project is tested for its first framework
      p.dll = await engine.targetPath(p.file, settings, p.framework);
      p.tests = [];
      if (p.dll && fs.existsSync(p.dll)) {
        const started = Date.now();
        p.tests = (await engine.listTests(p.dll)).map((fqn) => ({ key: `${p.file.toLowerCase()}|${fqn}`, fqn, project: p.file, projectName: p.name }));
        this.output.appendLine(`${T.discovered(p.tests.length, p.name)} (${formatDuration(Date.now() - started)})`);
      }
    }));
    this.projects = projects.sort((a, b) => a.name.localeCompare(b.name));
    this.files.clear();
    this.tests = this.projects.flatMap((p) => p.tests);
    for (const key of [...this.results.keys()]) if (!this.tests.some((x) => x.key === key)) this.results.delete(key);
    this.watch();
    this.refresh();
  }

  /** A rebuilt assembly shows its tests again, as VS discovers after a build. */
  watch() {
    for (const w of this.watchers) w.dispose();
    this.watchers = this.projects.filter((p) => p.dll).map((p) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(p.dll), path.basename(p.dll)));
      let timer;
      const again = () => { clearTimeout(timer); timer = setTimeout(() => !this.runner && this.discover(p.file), 1500); };
      w.onDidChange(again);
      w.onDidCreate(again);
      return w;
    });
  }

  // ---- the tree ------------------------------------------------------------------------------------------------

  refresh() {
    const shown = this.visible();
    this.roots = engine.groupTests(shown, this.mode, this.results, label);
    this.nodes = new Map();
    const index = (n) => { this.nodes.set(n.id, n); n.children.forEach(index); };
    this.roots.forEach(index);
    const count = (state) => this.tests.filter((x) => engine.stateOf(x, this.results) === state).length;
    this.view.description = this.tests.length ? `${this.tests.length} · ✔ ${count('passed')} ✖ ${count('failed')} ⊘ ${count('skipped')}` : '';
    this.view.message = !this.tests.length ? T.empty : !shown.length ? T.filtered : undefined;
    vscode.commands.executeCommand('setContext', 'csharpShooter.tests.filtered', !!this.filter);
    vscode.commands.executeCommand('setContext', 'csharpShooter.tests.any', this.tests.length > 0);
    this.changed.fire();
    this.details?.update();
  }

  visible() {
    return this.filter ? this.tests.filter((x) => engine.matchesFilter(x, this.results, this.filter, FILTER_STATE_WORDS)) : this.tests;
  }

  getChildren(node) {
    return node ? node.children : this.roots;
  }

  getTreeItem(node) {
    const state = node.kind === 'test' ? this.stateKey(node.test) : this.groupKey(node.tests);
    const open = node.kind === 'class' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(node.name, node.kind === 'test' ? vscode.TreeItemCollapsibleState.None : open);
    item.id = node.id;
    item.iconPath = icon(state);
    item.contextValue = node.kind === 'test' ? 'test' : node.kind;
    const ms = node.tests.reduce((sum, x) => sum + (this.results.get(x.key)?.duration || 0), 0);
    const ran = node.tests.some((x) => this.results.has(x.key));
    item.description = node.kind === 'test' ? (ran ? formatDuration(ms) : '') : `(${node.tests.length})${ran ? `  ${formatDuration(ms)}` : ''}`;
    item.tooltip = node.kind === 'test' ? node.test.fqn : `${node.name} (${node.tests.length})`;
    return item;
  }

  stateKey(test) {
    return this.active.has(test.key) ? 'running' : this.queued.has(test.key) ? 'queued' : engine.stateOf(test, this.results);
  }

  groupKey(tests) {
    if (tests.some((x) => this.active.has(x.key))) return 'running';
    if (tests.some((x) => this.queued.has(x.key))) return 'queued';
    return engine.groupState(tests, this.results);
  }

  // ---- the details under the tree ------------------------------------------------------------------------------

  /** What the Test Detail Summary shows for the selected node (a test, or a group's counts). */
  describe(node) {
    if (!node) return { kind: 'empty', text: T.selectOne };
    const count = (s) => node.tests.filter((x) => engine.stateOf(x, this.results) === s).length;
    if (node.kind !== 'test') {
      const ms = node.tests.reduce((sum, x) => sum + (this.results.get(x.key)?.duration || 0), 0);
      return { kind: 'group', name: node.name, lines: [T.total(node.tests.length), T.passedCount(count('passed')), T.failedCount(count('failed')), T.skippedCount(count('skipped')),
        T.notRunCount(count('notrun'))], durationLabel: T.totalDuration, duration: formatDuration(ms) };
    }
    const r = this.results.get(node.test.key);
    const where = this.locate(node.test);
    return {
      kind: 'test', name: node.test.fqn, state: T[STATES[engine.stateOf(node.test, this.results)]], stateKey: engine.stateOf(node.test, this.results),
      source: where ? { text: T.location(path.basename(where.file), where.line), file: where.file, line: where.line } : { text: T.noSource },
      labels: { source: T.source, duration: T.duration, message: T.message, stack: T.stack, stdout: T.stdout, stderr: T.stderr },
      duration: r ? formatDuration(r.duration) : '', message: r?.message || '', stdout: r?.stdout || '', stderr: r?.stderr || '',
      stack: r?.stack ? { text: r.stack, links: engine.stackLinks(r.stack) } : undefined,
    };
  }

  /** The source of a test: its class and its method in the project's .cs files (the first class of that name). */
  locate(test) {
    const { className, method } = engine.splitName(test.fqn);
    const cls = className.split('+').pop();
    let files = this.files.get(test.project);
    if (!files) {
      files = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) { if (!/^(bin|obj|node_modules|\.git|\.vs)$/i.test(entry.name)) walk(path.join(dir, entry.name)); } else if (/\.cs$/i.test(entry.name)) files.push(path.join(dir, entry.name));
        }
      };
      try { walk(path.dirname(test.project)); } catch { /* unreadable folder */ }
      this.files.set(test.project, files);
    }
    const classRe = new RegExp(`\\b(?:class|record|struct)\\s+${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const methodRe = new RegExp(`\\b${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:<[^>\\n]*>)?\\s*\\(`);
    for (const file of files) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const c = classRe.exec(text);
      if (!c) continue;
      const m = methodRe.exec(text.slice(c.index));
      if (m) return { file, line: text.slice(0, c.index + m.index).split('\n').length };
    }
    return undefined;
  }

  async openTest(node) {
    const where = node?.test && this.locate(node.test);
    if (!where) return node?.test && vscode.window.showWarningMessage(T.notFound(node.test.fqn));
    const doc = await vscode.workspace.openTextDocument(where.file);
    const at = new vscode.Position(where.line - 1, 0);
    return vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
  }

  // ---- running and debugging -----------------------------------------------------------------------------------

  /** The tests under nodes: a node's own (the ones that pass the filter), the selection's when no node is given. */
  testsOf(nodes) {
    const picked = (nodes?.length ? nodes : this.view.selection.length ? this.view.selection : []);
    return [...new Map(picked.flatMap((n) => n.tests).map((x) => [x.key, x])).values()];
  }

  /** Run All with nothing built yet: the test projects are built so their tests can be found, as VS builds then discovers. */
  async prepare() {
    const unbuilt = this.projects.filter((p) => !p.tests.length);
    if (!unbuilt.length || this.runner || this.running) return;
    this.output.show(true);
    for (const p of unbuilt) await engine.buildProject(p.file, buildArgs(await this.startup.buildSettings(p.file)), { framework: p.framework }, (text) => this.output.append(text));
    await this.load();
  }

  async runIn(tests, debug) {
    if (!tests.length) return void vscode.window.showInformationMessage(T.none);
    if (this.runner || this.running) return void vscode.window.showWarningMessage(T.running);
    if (vscode.debug.activeDebugSession) return void vscode.window.showWarningMessage(T.whileDebugging);
    this.running = true;
    this.cancelled = false;
    vscode.commands.executeCommand('setContext', 'csharpShooter.tests.running', true);
    this.last = { keys: tests.map((x) => x.key), debug };
    await vscode.workspace.saveAll(false);
    this.queued = new Set(tests.map((x) => x.key));
    this.refresh();
    this.output.show(true);
    this.output.appendLine(T.startRun);
    const started = Date.now();
    const seen = { run: 0, passed: 0, failed: 0, skipped: 0 };
    let buildFailed = false;
    try {
      const byProject = new Map();
      for (const x of tests) byProject.set(x.project, [...(byProject.get(x.project) || []), x]);
      for (const [file, list] of byProject) {
        if (this.cancelled) break;
        const project = this.projects.find((p) => p.file === file);
        const all = list.length === project.tests.length;
        const batches = all ? [undefined] : engine.chunks(list.map((x) => x.fqn));
        const args = buildArgs(await this.startup.buildSettings(file));
        for (const [i, fqns] of batches.entries()) {
          if (this.cancelled) break;
          const now = fqns ? list.filter((x) => fqns.includes(x.fqn)) : list;
          for (const x of now) { this.queued.delete(x.key); this.active.add(x.key); }
          this.refresh();
          const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
          let session;
          if (debug) this.output.appendLine(T.startDebug);
          this.runner = engine.runTests({ project: file, args, fqns, noBuild: i > 0, debug, framework: project.framework }, {
            onOutput: (text) => this.output.append(text),
            onAttach: async (pid) => {
              const started = await vscode.debug.startDebugging(folder, { type: 'csharpshooter', request: 'attach', name: `${T.view}: ${project.name}`, processId: pid, justMyCode: true });
              if (!started) { vscode.window.showErrorMessage(T.cannotAttach); this.runner.cancel(); }
              session = vscode.debug.activeDebugSession;
            },
          });
          const ended = vscode.debug.onDidTerminateDebugSession((s) => s === session && this.runner?.cancel());
          const { code, results } = await this.runner.done;
          ended.dispose();
          this.runner = undefined;
          if (session) await vscode.debug.stopDebugging(session);
          if (!results.size && code !== 0 && !this.cancelled) buildFailed = true;
          for (const [fqn, r] of results) {
            const key = `${file.toLowerCase()}|${fqn}`;
            this.results.set(key, r);
            seen.run++;
            seen[r.outcome]++;
          }
          for (const x of now) this.active.delete(x.key);
          this.refresh();
        }
        await this.discover(file); // a build may have found tests, or lost some
      }
    } finally {
      this.queued.clear();
      this.active.clear();
      this.running = false;
      this.runner = undefined;
      vscode.commands.executeCommand('setContext', 'csharpShooter.tests.running', false);
      this.refresh();
    }
    const summary = [seen.run, formatDuration(Date.now() - started), seen.passed, seen.failed, seen.skipped];
    this.output.appendLine((this.cancelled ? T.abortRun : T.endRun)(...summary));
    if (buildFailed) vscode.window.showErrorMessage(T.buildFailed);
    else if (!this.cancelled) vscode.window.setStatusBarMessage(T.statusRun(seen.run, seen.passed, seen.failed, seen.skipped), 15000);
  }

  cancel() {
    this.cancelled = true;
    this.runner?.cancel();
  }

  /** The tests the cursor is in: the method under it, else its class, among the tests of the file's project. */
  async testsInContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !/\.cs$/i.test(editor.document.fileName)) return [];
    const project = projectOf(editor.document.fileName);
    const mine = this.tests.filter((x) => project && same(x.project, project));
    const symbols = (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', editor.document.uri)) || [];
    const chain = [];
    const descend = (list) => {
      const hit = list.find((s) => s.range.contains(editor.selection.active));
      if (hit) { chain.push(hit); descend(hit.children || []); }
    };
    descend(symbols);
    const method = chain.reverse().find((s) => s.kind === vscode.SymbolKind.Method);
    const cls = chain.find((s) => s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Struct);
    const named = (x, name) => new RegExp(`(^|[.+])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(engine.splitName(x.fqn).fullClass);
    if (method && cls) {
      const m = method.name.replace(/\(.*$/, '');
      const found = mine.filter((x) => named(x, cls.name) && engine.splitName(x.fqn).method === m);
      if (found.length) return found;
    }
    return cls ? mine.filter((x) => named(x, cls.name)) : [];
  }

  // ---- the toolbar ---------------------------------------------------------------------------------------------

  async pickGrouping() {
    const names = { hierarchy: T.hierarchy, class: T['group.class'], namespace: T['group.namespace'], project: T['group.project'], state: T['group.state'], duration: T['group.duration'] };
    const picked = await vscode.window.showQuickPick(MODES.map((m) => ({ label: names[m], description: m === this.mode ? '✓' : '', mode: m })), { placeHolder: T.groupPrompt });
    if (!picked) return;
    this.mode = picked.mode;
    await this.context.workspaceState.update('csharpShooter.tests.groupBy', this.mode);
    this.refresh();
  }

  async askFilter() {
    const text = await vscode.window.showInputBox({ prompt: T.filterPrompt, placeHolder: T.search, value: this.filter });
    if (text === undefined) return;
    this.filter = text.trim();
    this.refresh();
  }
}

/** The Test Detail Summary: a webview under the tree that follows its selection. */
class DetailsView {
  constructor(explorer) {
    this.explorer = explorer;
    this.webview = undefined;
    this.shown = { kind: 'empty', text: T.selectOne }; // what it shows (the tests read it)
  }

  update() {
    const node = this.explorer.view.selection[0];
    this.shown = this.explorer.describe(this.explorer.nodes.get(node?.id));
    this.webview?.postMessage(this.shown);
  }

  resolveWebviewView(view) {
    this.webview = view.webview;
    view.webview.options = { enableScripts: true };
    const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
  body { font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); padding: 6px 10px; margin: 0; }
  h4 { margin: 4px 0 6px; word-break: break-all; font-weight: 600; }
  .row { margin: 3px 0; } .row b { font-weight: 600; margin-right: 6px; }
  pre { margin: 2px 0 8px; padding: 4px 6px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; } a:hover { text-decoration: underline; }
  .failed { color: var(--vscode-testing-iconFailed); } .passed { color: var(--vscode-testing-iconPassed); } .muted { opacity: .7; }
</style></head><body><div id="root"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const link = (text, file, line) => '<a data-file="' + esc(file) + '" data-line="' + line + '">' + esc(text) + '</a>';
  const withLinks = (s) => { let out = '', at = 0; for (const l of s.links) { out += esc(s.text.slice(at, l.start)) + link(s.text.slice(l.start, l.end), l.file, l.line); at = l.end; } return out + esc(s.text.slice(at)); };
  const block = (title, body) => body ? '<div class="row"><b>' + esc(title) + '</b></div><pre>' + body + '</pre>' : '';
  const show = (m) => {
    let html = '';
    if (m.kind === 'empty') html = '<div class="muted">' + esc(m.text) + '</div>';
    else if (m.kind === 'group') html = '<h4>' + esc(m.name) + '</h4>' + m.lines.map((l) => '<div class="row">' + esc(l) + '</div>').join('') + '<div class="row"><b>' + esc(m.durationLabel) + ':</b>' + esc(m.duration) + '</div>';
    else {
      html = '<h4><span class="' + esc(m.stateKey) + '">' + esc(m.state) + '</span> ' + esc(m.name) + '</h4>' +
        '<div class="row"><b>' + esc(m.labels.source) + ':</b>' + (m.source.file ? link(m.source.text, m.source.file, m.source.line) : '<span class="muted">' + esc(m.source.text) + '</span>') + '</div>' +
        (m.duration ? '<div class="row"><b>' + esc(m.labels.duration) + ':</b>' + esc(m.duration) + '</div>' : '') +
        block(m.labels.message, esc(m.message)) + block(m.labels.stack, m.stack ? withLinks(m.stack) : '') + block(m.labels.stdout, esc(m.stdout)) + block(m.labels.stderr, esc(m.stderr));
    }
    document.getElementById('root').innerHTML = html;
  };
  document.addEventListener('click', (e) => { const a = e.target.closest('a[data-file]'); if (a) vscode.postMessage({ type: 'open', file: a.dataset.file, line: +a.dataset.line }); });
  window.addEventListener('message', (e) => show(e.data));
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'ready') return this.update();
      if (m.type !== 'open' || !fs.existsSync(m.file)) return;
      const doc = await vscode.workspace.openTextDocument(m.file);
      const at = new vscode.Position(Math.max(0, m.line - 1), 0);
      vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
    });
  }
}

function registerTestExplorer(context, findSolution, startup) {
  const explorer = new TestExplorer(context, findSolution, startup);
  explorer.view = vscode.window.createTreeView('csharpShooter.testExplorer', { treeDataProvider: explorer, showCollapseAll: true, canSelectMany: true });
  explorer.details = new DetailsView(explorer);
  context.subscriptions.push(explorer.view, explorer.output, vscode.window.registerWebviewViewProvider('csharpShooter.testDetails', explorer.details));
  context.subscriptions.push(explorer.view.onDidChangeSelection(() => explorer.details.update()));
  // Tests are looked for when the Test Explorer is first shown (a solution with no test project costs nothing).
  const ensure = () => (explorer.loaded ||= explorer.load());
  context.subscriptions.push(explorer.view.onDidChangeVisibility((e) => e.visible && ensure()));
  if (explorer.view.visible) ensure();
  context.subscriptions.push({ dispose: () => explorer.watchers.forEach((w) => w.dispose()) });

  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const nodesOf = (node, selected) => (node ? (selected?.includes(node) ? selected : [node]) : undefined);
  register('csharpShooter.tests.show', async () => { await vscode.commands.executeCommand('workbench.view.extension.csharpShooter'); await ensure(); });
  register('csharpShooter.tests.runAll', async () => { await ensure(); await explorer.prepare(); return explorer.runIn(explorer.visible(), false); });
  register('csharpShooter.tests.debugAll', async () => { await ensure(); await explorer.prepare(); return explorer.runIn(explorer.visible(), true); });
  register('csharpShooter.tests.run', (node, selected) => explorer.runIn(explorer.testsOf(nodesOf(node, selected)), false));
  register('csharpShooter.tests.debug', (node, selected) => explorer.runIn(explorer.testsOf(nodesOf(node, selected)), true));
  register('csharpShooter.tests.runFailed', () => explorer.runIn(explorer.tests.filter((x) => engine.stateOf(x, explorer.results) === 'failed'), false));
  const inContext = (debug) => async () => {
    await ensure();
    const tests = await explorer.testsInContext();
    if (!tests.length) return void vscode.window.showInformationMessage(T.noInContext);
    return explorer.runIn(tests, debug);
  };
  register('csharpShooter.tests.runInContext', inContext(false));
  register('csharpShooter.tests.debugInContext', inContext(true));
  register('csharpShooter.tests.repeat', () => explorer.last && explorer.runIn(explorer.tests.filter((x) => explorer.last.keys.includes(x.key)), explorer.last.debug));
  register('csharpShooter.tests.cancel', () => explorer.cancel());
  register('csharpShooter.tests.refresh', () => explorer.load());
  register('csharpShooter.tests.groupBy', () => explorer.pickGrouping());
  register('csharpShooter.tests.filter', () => explorer.askFilter());
  register('csharpShooter.tests.clearFilter', () => { explorer.filter = ''; explorer.refresh(); });
  register('csharpShooter.tests.clearResults', () => { explorer.results.clear(); explorer.refresh(); });
  register('csharpShooter.tests.goToTest', (node) => explorer.openTest(node || explorer.view.selection[0]));
  vscode.commands.executeCommand('setContext', 'csharpShooter.tests.running', false);
  return { explorer, ensure };
}

module.exports = { registerTestExplorer, formatDuration };
