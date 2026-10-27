// What the Test Explorer does without VS Code: finds the tests of a built test assembly (vstest's own list of fully
// qualified names, as VS's Test Explorer gets them), runs them through `dotnet test` (a VSTEST filter, a TRX log), reads the
// TRX back, and groups the tests for the tree. Debugging a run is VSTEST_HOST_DEBUG: the test host waits for a debugger and
// says its process id, which test-explorer.js attaches to.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const UNESCAPE = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
  (m, hex, dec, name) => (name ? UNESCAPE[name.toLowerCase()] : String.fromCodePoint(hex ? parseInt(hex, 16) : parseInt(dec, 10))));
const attributes = (text) => Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], unescapeXml(m[2])]));

/** "00:00:01.5000000" -> milliseconds. */
function durationMs(text) {
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(text || '');
  return m ? Math.round((((+(m[1] || 0) * 24 + +m[2]) * 60 + +m[3]) * 60 + +m[4]) * 1000) : 0;
}

/** The outcome of a TRX result as the explorer knows it: passed, failed, skipped (not executed, inconclusive). */
const outcomeOf = (trx) => (/^passed$/i.test(trx) ? 'passed' : /^(failed|timeout|aborted|error)$/i.test(trx) ? 'failed' : 'skipped');
const WORST = { failed: 3, passed: 2, skipped: 1 };

/** A TRX file's results by test, as Map fully qualified name -> { outcome, duration, message, stack, stdout, stderr }; the
 *  rows of a theory (one result each) are one test: failed if any failed, their times added. */
function parseTrx(xml) {
  const methods = new Map(); // testId -> fully qualified name
  for (const m of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const method = /<TestMethod\b([^>]*?)\/?>/.exec(m[2]);
    if (!method) continue;
    const a = attributes(method[1]);
    methods.set(attributes(m[1]).id, `${a.className}.${a.name}`);
  }
  const results = new Map();
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const a = attributes(m[1]);
    const body = m[2] || '';
    const tag = (name) => { const t = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body); return t ? unescapeXml(t[1]).trim() : ''; };
    const fqn = methods.get(a.testId) || a.testName;
    const outcome = outcomeOf(a.outcome);
    const one = { outcome, duration: durationMs(a.duration), message: tag('Message'), stack: tag('StackTrace'), stdout: tag('StdOut'), stderr: tag('StdErr') };
    const before = results.get(fqn);
    if (!before) { results.set(fqn, one); continue; }
    before.duration += one.duration;
    if (WORST[outcome] > WORST[before.outcome]) before.outcome = outcome;
    for (const k of ['message', 'stack', 'stdout', 'stderr']) before[k] = [before[k], one[k]].filter(Boolean).join(k === 'stack' ? '\n' : '\n\n');
  }
  return results;
}

/** A `dotnet test --filter` that picks these tests: FullyQualifiedName=a|FullyQualifiedName=b, with the characters the
 *  filter language reads escaped. */
const filterFor = (fqns) => fqns.map((f) => `FullyQualifiedName=${f.replace(/[\\()&|=!~]/g, '\\$&')}`).join('|');

/** The names in lists no longer than a command line allows. */
function chunks(fqns, limit = 8000) {
  const out = [];
  let current = [];
  let size = 0;
  for (const f of fqns) {
    if (current.length && size + f.length + 30 > limit) { out.push(current); current = []; size = 0; }
    current.push(f);
    size += f.length + 30;
  }
  if (current.length) out.push(current);
  return out;
}

/** Namespace, class and method of a fully qualified name: Ns.Sub.Class.Method (a nested class is Outer+Inner). */
function splitName(fqn) {
  const cut = fqn.lastIndexOf('.');
  const type = cut < 0 ? '' : fqn.slice(0, cut);
  const dot = type.lastIndexOf('.');
  return { fullClass: type, namespace: dot < 0 ? '' : type.slice(0, dot), className: dot < 0 ? type : type.slice(dot + 1), method: fqn.slice(cut + 1) };
}

/** Whether a project file is a test project: it references Microsoft.NET.Test.Sdk, or says IsTestProject. */
function isTestProject(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    return /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(text) || (/Microsoft\.NET\.Test\.Sdk/i.test(text) && !/<IsTestProject>\s*false/i.test(text));
  } catch {
    return false;
  }
}

const runDotnet = (args, options) => new Promise((resolve) => execFile('dotnet', args,
  { windowsHide: true, maxBuffer: 64 << 20, ...options }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));

/** The built assembly of a test project for a configuration (and framework), from MSBuild. */
async function targetPath(project, { configuration, platform }, framework) {
  const { stdout } = await runDotnet(['msbuild', project, '-getProperty:TargetPath', `-p:Configuration=${configuration}`,
    ...(platform && !/^any\s?cpu$/i.test(platform) ? [`-p:Platform=${platform}`] : []), ...(framework ? [`-p:TargetFramework=${framework}`] : [])],
  { cwd: path.dirname(project) });
  return stdout.trim().split(/\r?\n/).pop() || undefined; // one -getProperty prints the bare value
}

/** The fully qualified names of the tests in a built assembly (vstest's /ListFullyQualifiedTests), [] when there are none. */
async function listTests(dll) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csharpshooter-tests-')), 'list.txt');
  try {
    await runDotnet(['vstest', dll, '/ListFullyQualifiedTests', `/ListTestsTargetPath:${out}`], { cwd: path.dirname(dll), timeout: 120000 });
    return fs.existsSync(out) ? [...new Set(fs.readFileSync(out, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))] : [];
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
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

/** One `dotnet test` of a project: the tests (all of them without a filter), built first unless noBuild. With debug the test
 *  host waits for a debugger: onAttach(pid) is called with its process id. Resolves { code, results } once the process ends. */
function runTests({ project, args = [], fqns, noBuild, debug, framework }, { onOutput = () => {}, onAttach = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csharpshooter-tests-'));
  const trx = 'run.trx';
  const argv = ['test', project, ...args, ...(framework ? ['-f', framework] : []), '--nologo', '--logger', `trx;LogFileName=${trx}`, '--results-directory', dir,
    ...(noBuild ? ['--no-build'] : []), ...(fqns ? ['--filter', filterFor(fqns)] : [])];
  const child = spawn('dotnet', argv, { cwd: path.dirname(project), windowsHide: true, env: { ...process.env, ...(debug ? { VSTEST_HOST_DEBUG: '1' } : {}) } });
  let attached = false;
  const read = (data) => {
    const text = data.toString();
    onOutput(text);
    const pid = !attached && /Process Id:\s*(\d+)/.exec(text);
    if (pid) { attached = true; onAttach(+pid[1]); }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  const done = new Promise((resolve) => {
    const finish = (code) => {
      let results = new Map();
      try { results = parseTrx(fs.readFileSync(path.join(dir, trx), 'utf8')); } catch { /* no log: the build failed, or the run was cancelled */ }
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, results });
    };
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
  const cancel = () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill('SIGKILL');
  };
  return { done, cancel };
}

// ---- the tree ---------------------------------------------------------------------------------------------------

/** The state a test shows: its result's outcome, or notrun. */
const stateOf = (test, results) => results.get(test.key)?.outcome || 'notrun';

/** The state of a group: failed if a test failed, else not run if any was, else passed, else skipped. */
function groupState(tests, results) {
  const states = new Set(tests.map((t) => stateOf(t, results)));
  return states.has('failed') ? 'failed' : states.has('notrun') ? 'notrun' : states.has('passed') ? 'passed' : states.size ? 'skipped' : 'notrun';
}

const DURATION_BUCKETS = [[30000, 'slowest'], [15000, 'slower'], [1000, 'slow'], [100, 'medium'], [0, 'fast']];
const bucketOf = (test, results) => {
  const r = results.get(test.key);
  return r ? DURATION_BUCKETS.find(([from]) => r.duration >= from)[1] : 'none';
};

/** The tree of tests for a grouping: nodes { id, kind, name, children, tests } with the tests leaves ({ kind: 'test' }).
 *  `label(kind, value)` names the groups that stand for something (a state, a duration class, an empty namespace). */
function groupTests(tests, mode, results, label = (kind, value) => value) {
  const leaf = (test, parent) => ({ id: `${parent}/${test.key}`, kind: 'test', name: splitName(test.fqn).method, test, tests: [test], children: [] });
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
  const byNamespace = (items, parent, below) => bucket(parent, items, 'namespace', (t) => splitName(t.fqn).namespace, (k) => k || label('namespace', ''))
    .map((g) => finish(g, below(g.list, g.id)));
  const byClass = (items, parent, below, full) => bucket(parent, items, 'class', (t) => (full ? splitName(t.fqn).fullClass : splitName(t.fqn).className) || '', (k) => k || label('class', ''))
    .map((g) => finish(g, below(g.list, g.id)));
  const leaves = (items, parent) => items.slice().sort((a, b) => splitName(a.fqn).method.localeCompare(splitName(b.fqn).method)).map((t) => leaf(t, parent));
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
  const name = splitName(test.fqn);
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
      case '': case 'name': hit = test.fqn.toLowerCase().includes(value); break;
      default: hit = `${key}:${quoted ?? bare}`.length > 0 && test.fqn.toLowerCase().includes(`${key}:${value}`);
    }
    return not ? !hit : hit;
  });
}

/** The places a stack trace names ("in C:\x\A.cs:line 12"), as [{ start, end, file, line }] in the text. */
function stackLinks(stack) {
  return [...stack.matchAll(/ in (.+?):line (\d+)/g)].map((m) => ({ start: m.index + 4, end: m.index + m[0].length, file: m[1], line: +m[2] }));
}

module.exports = { buildProject, parseTrx, filterFor, chunks, splitName, isTestProject, targetPath, listTests, runTests, stateOf, groupState, groupTests, matchesFilter, stackLinks, durationMs };
