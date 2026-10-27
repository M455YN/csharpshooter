// What the Test Explorer does without VS Code, as Visual Studio 2026's Test Explorer does it: a test project whose project
// capabilities say TestingPlatformServer is a Microsoft.Testing.Platform program, asked for its tests and run in its server
// mode (`--server --client-port`, JSON-RPC: initialize, testing/discoverTests, testing/runTests, testing/testUpdates/tests);
// every other one is VSTest's, found and run by vstest.console through VSTest's translation layer (testbridge/, a small
// .NET program that drives VsTestConsoleWrapper). Results come as they happen. Debugging is the debugger attaching to the
// process the tests run in: VSTest's test host asks for it (ITestHostLauncher3.AttachDebuggerToProcess) and waits until
// the debugger has it; a Testing Platform program is attached to before it is asked to run anything.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFile, spawn } = require('child_process');

const BRIDGE_DLL = 'CSharpShooter.TestBridge.dll';
/** The bridge as it ships (testbridge/out, scripts/build-testbridge.ps1), or as `dotnet build -c Release` leaves it. */
const bridgePath = () => [path.join(__dirname, 'testbridge', 'out', BRIDGE_DLL), path.join(__dirname, 'testbridge', 'bin', 'Release', 'net8.0', BRIDGE_DLL)].find((p) => fs.existsSync(p));

/** Namespace, class and method of a fully qualified name: Ns.Sub.Class.Method (a nested class is Outer+Inner); the
 *  arguments of a parameterized test's name (Method(1, "a.b")) stay with the method. */
function splitName(fqn) {
  const paren = fqn.indexOf('(');
  const cut = fqn.lastIndexOf('.', paren < 0 ? fqn.length : paren);
  const type = cut < 0 ? '' : fqn.slice(0, cut);
  const dot = type.lastIndexOf('.');
  return { fullClass: type, namespace: dot < 0 ? '' : type.slice(0, dot), className: dot < 0 ? type : type.slice(dot + 1), method: fqn.slice(cut + 1) };
}

/** A test's namespace, class and method: from the type and method its framework names (ManagedType, location.type), else
 *  from its fully qualified name. `method` has no arguments; `name` is what the tree shows (the display name). */
function partsOf(test) {
  const named = splitName(test.fqn);
  const type = test.type || named.fullClass;
  const dot = type.lastIndexOf('.');
  const method = (test.method || named.method).replace(/\(.*$/s, '');
  // xUnit names a test by its class and method: the tree shows it without its class, as VS does.
  const name = test.name?.startsWith(`${type}.`) ? test.name.slice(type.length + 1) : test.name || named.method;
  return { fullClass: type, namespace: dot < 0 ? '' : type.slice(0, dot), className: dot < 0 ? type : type.slice(dot + 1), method, name };
}

/** Whether a project file is a test project: it references Microsoft.NET.Test.Sdk, says IsTestProject, or is a Testing
 *  Platform program (xUnit v3, TUnit, MSTest's or NUnit's runner, MSTest.Sdk). */
function isTestProject(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    if (/<IsTestProject>\s*false/i.test(text)) return false;
    return /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(text) || /Microsoft\.NET\.Test\.Sdk|xunit\.v3|"TUnit|MSTest\.Sdk|Microsoft\.Testing\.Platform|EnableMSTestRunner|EnableNUnitRunner/i.test(text);
  } catch {
    return false;
  }
}

const runDotnet = (args, options) => new Promise((resolve) => execFile('dotnet', args,
  { windowsHide: true, maxBuffer: 64 << 20, ...options }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));

/** The built assembly of a test project for a configuration (and framework), and whether it is a Testing Platform server
 *  (its ProjectCapability TestingPlatformServer, the capability Visual Studio looks at), from MSBuild. */
async function projectInfo(project, { configuration, platform }, framework) {
  const { stdout } = await runDotnet(['msbuild', project, '-getProperty:TargetPath', '-getItem:ProjectCapability', `-p:Configuration=${configuration}`,
    ...(platform && !/^any\s?cpu$/i.test(platform) ? [`-p:Platform=${platform}`] : []), ...(framework ? [`-p:TargetFramework=${framework}`] : [])],
  { cwd: path.dirname(project) });
  try {
    const json = JSON.parse(stdout.slice(stdout.indexOf('{')));
    const capabilities = (json.Items?.ProjectCapability || []).map((c) => c.Identity);
    return { dll: json.Properties?.TargetPath || undefined, mtp: capabilities.includes('TestingPlatformServer') };
  } catch {
    return { dll: undefined, mtp: false };
  }
}

/** `dotnet build` of a project, its output given to onOutput; resolves the exit code. */
function buildProject(project, args, { framework } = {}, onOutput = () => {}) {
  return new Promise((resolve) => {
    const child = spawn('dotnet', ['build', project, ...args, ...(framework ? ['-f', framework] : []), '--nologo'], { cwd: path.dirname(project), windowsHide: true });
    child.stdout.on('data', (d) => onOutput(d.toString()));
    child.stderr.on('data', (d) => onOutput(d.toString()));
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });
}

/** A path as a key: whole, in one case, with one kind of slash. */
const pathKey = (file) => path.resolve(file).toLowerCase();

// ---- VSTest, through the bridge ---------------------------------------------------------------------------------

/** vstest.console behind testbridge/: one process for the session, started when first asked. Its requests go one at a
 *  time (vstest.console does one thing at a time), except cancel. `handlers` of the request going now hear what it tells:
 *  found(tests), results(results), running(tests), log(level, message), and for a debugged run attach({ pid }) -> bool and
 *  launch({ file, args, cwd, env }) -> process id. */
class VsTest {
  constructor(log = () => {}) {
    this.log = log;
    this.child = undefined;
    this.pending = new Map();
    this.next = 0;
    this.queue = Promise.resolve();
    this.handlers = {};
  }

  start() {
    if (this.child) return;
    const bridge = bridgePath();
    if (!bridge) throw new Error('The test bridge is not built (testbridge/out): powershell -File scripts/build-testbridge.ps1');
    const child = spawn('dotnet', [bridge], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.on('data', (d) => this.log('error', d.toString()));
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    const gone = () => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const { reject } of this.pending.values()) reject(new Error('The test bridge ended'));
      this.pending.clear();
    };
    child.on('error', gone);
    child.on('exit', gone);
  }

  send(message) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async receive(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method && m.id !== undefined) { // the bridge asks: attach, launch
      const handler = this.handlers[m.method];
      try {
        this.send({ id: m.id, result: handler ? await handler(m.params) : null });
      } catch (error) {
        this.send({ id: m.id, error: { message: String(error?.message || error) } });
      }
      return;
    }
    if (m.method) {
      const p = m.params || {};
      if (m.method === 'found') this.handlers.found?.(p.tests);
      else if (m.method === 'results') this.handlers.results?.(p.results);
      else if (m.method === 'running') this.handlers.running?.(p.tests);
      else if (m.method === 'log') (this.handlers.log || this.log)(p.level, p.message);
      return;
    }
    const waiting = this.pending.get(m.id);
    if (!waiting) return;
    this.pending.delete(m.id);
    if (m.error) waiting.reject(new Error(m.error.message));
    else waiting.resolve(m.result);
  }

  request(method, params) {
    this.start();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  /** One request after the one before has ended, its handlers listening meanwhile. */
  exclusive(method, params, handlers) {
    const turn = this.queue.then(async () => {
      this.handlers = handlers;
      try { return await this.request(method, params); } finally { this.handlers = {}; }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** The tests in built assemblies: [{ id, fqn, name, source, file, line, type, method, traits }]. */
  async discover(sources, folder) {
    const tests = [];
    await this.exclusive('discover', { sources, folder }, { found: (list) => tests.push(...list) });
    return tests;
  }

  /** Runs tests by id (as discovered) or every test of sources; resolves { aborted, canceled, error, elapsed }. */
  run(params, handlers) {
    return this.exclusive('run', params, handlers);
  }

  cancel() {
    if (this.child) this.request('cancel', {}).catch(() => {});
  }

  dispose() {
    if (!this.child) return;
    this.send({ method: 'exit' });
    const child = this.child;
    setTimeout(() => child.exitCode === null && child.kill(), 5000);
    this.child = undefined;
  }
}

// ---- Microsoft.Testing.Platform, in its server mode ---------------------------------------------------------------

const MTP_STATES = { passed: 'passed', failed: 'failed', error: 'failed', 'timed-out': 'failed', skipped: 'skipped' };

/** A Testing Platform test node as a test: [{ id (its uid), fqn, name, file, line, type, method }], and its result when it
 *  has one ({ outcome, duration, message, stack, stdout, stderr }). */
function readNode(node) {
  const text = (k) => (typeof node[k] === 'string' ? node[k] : undefined);
  let type = text('location.type');
  const space = text('location.namespace');
  if (space && type && !type.startsWith(`${space}.`)) type = `${space}.${type}`;
  const method = text('location.method')?.replace(/\(.*$/s, '');
  const name = text('display-name') || node.uid;
  const fqn = type && method ? `${type}.${method}` : text('vstest.TestCase.FullyQualifiedName') || name;
  const test = { id: node.uid, fqn, name, file: text('location.file'), line: +node['location.line-start'] || 0, type, method, state: text('execution-state') };
  const outcome = MTP_STATES[test.state];
  if (outcome && !node['retry.is-superseded']) {
    test.result = { outcome, duration: +node['time.duration-ms'] || 0, message: text('error.message') || '', stack: text('error.stacktrace') || '',
      stdout: text('standardOutput') || '', stderr: text('standardError') || '' };
  }
  return test;
}

/** One Testing Platform program in its server mode, connected back to a port of ours and initialized. `attach(pid)`, when
 *  given, has the debugger take the program before anything is asked of it. */
async function mtpHost(dll, { log = () => {}, attach } = {}) {
  const { createMessageConnection, SocketMessageReader, SocketMessageWriter } = require('vscode-jsonrpc/node');
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = spawn('dotnet', ['exec', dll, '--server', '--client-host', '127.0.0.1', '--client-port', String(port)], { cwd: path.dirname(dll), windowsHide: true });
  let said = '';
  const keep = (d) => { said = (said + d.toString()).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path.basename(dll)} did not connect within 60 s\n${said}`)), 60000);
      server.once('connection', (s) => { clearTimeout(timer); resolve(s); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${path.basename(dll)} ended (exit code ${code}) before it connected\n${said}`)); });
    });
  } catch (error) {
    server.close();
    if (child.exitCode === null) child.kill();
    throw error;
  }
  server.close();
  const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
  const listeners = new Map(); // runId -> { changed, ended }
  connection.onNotification('testing/testUpdates/tests', (p) => {
    const run = listeners.get(p?.runId);
    if (!run) return;
    if (!Array.isArray(p.changes)) return void run.ended();
    run.changed(p.changes.map((c) => c?.node).filter((n) => n?.uid).map(readNode));
  });
  connection.onNotification('client/log', (p) => p?.message && log(p.level || 'information', p.message));
  connection.onRequest('client/attachDebugger', async (p) => attach && attach(p?.processId));
  connection.onError(() => {});
  connection.listen();
  const initialized = await connection.sendRequest('initialize', {
    processId: process.pid,
    clientInfo: { name: 'CSharpShooter', version: '1.0.0' },
    capabilities: { testing: { debuggerProvider: !!attach } },
  });
  const pid = initialized?.processId || child.pid;
  if (attach && !(await attach(pid))) throw new Error('The debugger could not attach to the test program.');
  return {
    pid,
    /** A discovery or a run: each changed node to `changed`, resolved once the program says it has told all. */
    async ask(method, params, changed) {
      const runId = crypto.randomUUID();
      let ended;
      const told = new Promise((resolve) => { ended = resolve; });
      listeners.set(runId, { changed, ended });
      try {
        await connection.sendRequest(method, { ...params, runId });
        await Promise.race([told, new Promise((r) => setTimeout(r, 5000))]);
      } finally {
        listeners.delete(runId);
      }
    },
    end() {
      try { connection.sendNotification('exit', {}); } catch { /* gone */ }
      setTimeout(() => { connection.dispose(); socket.destroy(); if (child.exitCode === null) kill(child.pid); }, 3000);
    },
    kill() {
      connection.dispose();
      socket.destroy();
      if (child.exitCode === null) kill(child.pid);
    },
  };
}

const kill = (pid) => (process.platform === 'win32' ? execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}) : process.kill(pid, 'SIGKILL'));

/** The tests of a built Testing Platform program. */
async function mtpDiscover(dll, { log } = {}) {
  const host = await mtpHost(dll, { log });
  const tests = new Map();
  try {
    await host.ask('testing/discoverTests', {}, (nodes) => nodes.forEach((n) => n.state === 'discovered' && tests.set(n.id, n)));
  } finally {
    host.end();
  }
  return [...tests.values()];
}

/** Runs tests of a Testing Platform program, [{ id, name }] as found (all of them when none are given): results(list), running(tests) as they
 *  come. { done, cancel }: done resolves { canceled }. */
function mtpRun(dll, tests, { results = () => {}, running = () => {}, log, attach } = {}) {
  let host;
  let canceled = false;
  const done = (async () => {
    host = await mtpHost(dll, { log, attach });
    if (canceled) { host.kill(); return { canceled }; }
    try {
      await host.ask('testing/runTests', tests ? { tests: tests.map((t) => ({ uid: t.id, 'display-name': t.name })) } : {}, (nodes) => {
        const finished = nodes.filter((n) => n.result);
        const started = nodes.filter((n) => n.state === 'in-progress');
        if (started.length) running(started);
        if (finished.length) results(finished.map((n) => ({ ...n, ...n.result })));
      });
    } catch (error) {
      if (!canceled) throw error;
    } finally {
      host.end();
    }
    return { canceled };
  })();
  return { done, cancel: () => { canceled = true; host?.kill(); } };
}

// ---- the tree ---------------------------------------------------------------------------------------------------

/** The state a test shows: its result's outcome, or notrun. */
const stateOf = (test, results) => results.get(test.key)?.outcome || 'notrun';

/** The state of a group: failed if a test failed, else not run if any was, else passed, else skipped. */
function groupState(tests, results) {
  const states = new Set(tests.map((t) => stateOf(t, results)));
  return states.has('failed') ? 'failed' : states.has('notrun') ? 'notrun' : states.has('passed') ? 'passed' : states.size ? 'skipped' : 'notrun';
}

/** A result that comes for a test already given one in this run (a theory's rows, a retried attempt): the worst outcome,
 *  the times added, the texts one after another. */
const WORST = { failed: 3, passed: 2, skipped: 1 };
function mergeResult(before, one) {
  before.duration += one.duration;
  if (WORST[one.outcome] > WORST[before.outcome]) before.outcome = one.outcome;
  for (const k of ['message', 'stack', 'stdout', 'stderr']) before[k] = [before[k], one[k]].filter(Boolean).join(k === 'stack' ? '\n' : '\n\n');
  return before;
}

const DURATION_BUCKETS = [[30000, 'slowest'], [15000, 'slower'], [1000, 'slow'], [100, 'medium'], [0, 'fast']];
const bucketOf = (test, results) => {
  const r = results.get(test.key);
  return r ? DURATION_BUCKETS.find(([from]) => r.duration >= from)[1] : 'none';
};

/** The tree of tests for a grouping: nodes { id, kind, name, children, tests } with the tests leaves ({ kind: 'test' }).
 *  `label(kind, value)` names the groups that stand for something (a state, a duration class, an empty namespace). */
function groupTests(tests, mode, results, label = (kind, value) => value) {
  const leaf = (test, parent) => ({ id: `${parent}/${test.key}`, kind: 'test', name: partsOf(test).name, test, tests: [test], children: [] });
  const bucket = (parent, items, kind, keyOf, nameOf, order) => {
    const groups = new Map();
    for (const item of items) {
      const k = keyOf(item);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    }
    return [...groups].sort((a, b) => (order ? order(a[0], b[0]) : String(a[0]).localeCompare(String(b[0])))).map(([k, list]) => ({ k, list, id: `${parent}/${kind}:${k}`, kind, name: nameOf(k) }));
  };
  const finish = (node, children) => ({ ...node, children, tests: children.flatMap((c) => c.tests) });
  const byProject = (items, parent, below) => bucket(parent, items, 'project', (t) => t.project, (k) => items.find((t) => t.project === k).projectName)
    .map((g) => finish(g, below(g.list, g.id)));
  const byNamespace = (items, parent, below) => bucket(parent, items, 'namespace', (t) => partsOf(t).namespace, (k) => k || label('namespace', ''))
    .map((g) => finish(g, below(g.list, g.id)));
  const byClass = (items, parent, below, full) => bucket(parent, items, 'class', (t) => (full ? partsOf(t).fullClass : partsOf(t).className) || '', (k) => k || label('class', ''))
    .map((g) => finish(g, below(g.list, g.id)));
  const leaves = (items, parent) => items.slice().sort((a, b) => partsOf(a).name.localeCompare(partsOf(b).name)).map((t) => leaf(t, parent));
  switch (mode) {
    case 'class': return byClass(tests, '', leaves, true);
    case 'namespace': return byNamespace(tests, '', leaves);
    case 'project': return byProject(tests, '', leaves);
    case 'state': return bucket('', tests, 'state', (t) => stateOf(t, results), (k) => label('state', k), (a, b) => ['failed', 'skipped', 'passed', 'notrun'].indexOf(a) - ['failed', 'skipped', 'passed', 'notrun'].indexOf(b))
      .map((g) => finish(g, leaves(g.list, g.id)));
    case 'duration': return bucket('', tests, 'duration', (t) => bucketOf(t, results), (k) => label('duration', k),
      (a, b) => ['slowest', 'slower', 'slow', 'medium', 'fast', 'none'].indexOf(a) - ['slowest', 'slower', 'slow', 'medium', 'fast', 'none'].indexOf(b)).map((g) => finish(g, leaves(g.list, g.id)));
    default: return byProject(tests, '', (a, p) => byNamespace(a, p, (b, q) => byClass(b, q, leaves, false)));
  }
}

/** "Class:Foo -State:Failed text": whether a test passes the filter. Keys: Class, Namespace, Project, State, FullName
 *  (and Name); a bare word matches the name; a leading - negates; values match as substrings, in any case. `stateNames`
 *  gives the words each state answers to (in the UI's language too). */
function matchesFilter(test, results, text, stateNames = {}) {
  const terms = [...text.matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)];
  const name = partsOf(test);
  return terms.every(([, not, key, quoted, bare]) => {
    const value = (quoted ?? bare).toLowerCase();
    let hit;
    switch ((key || '').toLowerCase()) {
      case 'class': hit = name.fullClass.toLowerCase().includes(value) || name.className.toLowerCase().includes(value); break;
      case 'namespace': hit = name.namespace.toLowerCase().includes(value); break;
      case 'project': hit = test.projectName.toLowerCase().includes(value); break;
      case 'fullname': hit = test.fqn.toLowerCase().includes(value); break;
      case 'state': {
        const state = stateOf(test, results);
        hit = [state, ...(stateNames[state] || [])].some((w) => w.toLowerCase().startsWith(value));
        break;
      }
      case '': case 'name': hit = test.fqn.toLowerCase().includes(value) || name.name.toLowerCase().includes(value); break;
      default: hit = `${key}:${quoted ?? bare}`.length > 0 && test.fqn.toLowerCase().includes(`${key}:${value}`);
    }
    return not ? !hit : hit;
  });
}

/** The places a stack trace names ("in C:\x\A.cs:line 12"), as [{ start, end, file, line }] in the text. */
function stackLinks(stack) {
  return [...stack.matchAll(/ in (.+?):line (\d+)/g)].map((m) => ({ start: m.index + 4, end: m.index + m[0].length, file: m[1], line: +m[2] }));
}

module.exports = {
  VsTest, mtpDiscover, mtpRun, readNode, bridgePath, buildProject, splitName, partsOf, isTestProject, projectInfo, pathKey, kill,
  stateOf, groupState, mergeResult, groupTests, matchesFilter, stackLinks,
};
