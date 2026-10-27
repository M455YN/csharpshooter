// The Test Explorer's engine against a few names and Testing Platform nodes, and (with TEST_PROJECT set to a built test
// project file) against that project, through vstest.console's bridge or the Testing Platform's server mode:
//   node test/test-engine.js
const assert = require('assert');
const e = require('../test-engine');

assert.deepStrictEqual(e.splitName('A.B.C.Adds'), { fullClass: 'A.B.C', namespace: 'A.B', className: 'C', method: 'Adds' });
assert.deepStrictEqual(e.splitName('C.Adds'), { fullClass: 'C', namespace: '', className: 'C', method: 'Adds' });
assert.deepStrictEqual(e.splitName('A.C.Case(1.5,"x.y")'), { fullClass: 'A.C', namespace: 'A', className: 'C', method: 'Case(1.5,"x.y")' });
assert.deepStrictEqual(e.partsOf({ fqn: 'A.C.Case(1.5)', name: 'Case(1.5)' }), { fullClass: 'A.C', namespace: 'A', className: 'C', method: 'Case', name: 'Case(1.5)' });
assert.deepStrictEqual(e.partsOf({ fqn: 'x', type: 'N.S.T', method: 'M(Int32)', name: 'Shown' }), { fullClass: 'N.S.T', namespace: 'N.S', className: 'T', method: 'M', name: 'Shown' });
assert.deepStrictEqual(e.stackLinks(String.raw`at X() in C:\s\A.cs:line 6` + '\r\nat Y()').map((l) => [l.file, l.line]), [[String.raw`C:\s\A.cs`, 6]]);

const node = e.readNode({ uid: 'u1', 'display-name': 'Adds', 'execution-state': 'failed', 'location.namespace': 'A.B', 'location.type': 'C', 'location.method': 'Adds(Int32)',
  'location.file': 'C:\\s\\C.cs', 'location.line-start': 7, 'time.duration-ms': 12.5, 'error.message': 'boom', 'error.stacktrace': 'at C.Adds()' });
assert.strictEqual(node.fqn, 'A.B.C.Adds');
assert.strictEqual(node.line, 7);
assert.deepStrictEqual(node.result, { outcome: 'failed', duration: 12.5, message: 'boom', stack: 'at C.Adds()', stdout: '', stderr: '' });
assert.strictEqual(e.readNode({ uid: 'u2', 'execution-state': 'discovered' }).result, undefined);
assert.strictEqual(e.readNode({ uid: 'u3', 'execution-state': 'failed', 'retry.is-superseded': true }).result, undefined);

const merged = e.mergeResult({ outcome: 'passed', duration: 100, message: '', stack: '', stdout: 'a', stderr: '' }, { outcome: 'failed', duration: 200, message: 'm', stack: '', stdout: 'b', stderr: '' });
assert.deepStrictEqual(merged, { outcome: 'failed', duration: 300, message: 'm', stack: '', stdout: 'a\n\nb', stderr: '' });

const test = (project, fqn) => ({ key: `${project}|${fqn}`, fqn, project, projectName: project });
const tests = ['A.B.C.Adds', 'A.B.C.Fails', 'A.D.E.Works', 'Top.Run'].map((f) => test('p', f)).concat([test('q', 'A.B.C.Adds')]);
const results = new Map([['p|A.B.C.Fails', { outcome: 'failed', duration: 20 }], ['p|A.B.C.Adds', { outcome: 'passed', duration: 2000 }]]);
const tree = e.groupTests(tests, 'hierarchy', results);
assert.deepStrictEqual(tree.map((n) => n.name), ['p', 'q']);
assert.deepStrictEqual(tree[0].children.map((n) => n.name), ['', 'A.B', 'A.D']); // namespace '' sorts first
assert.strictEqual(tree[0].children[1].children[0].name, 'C');
assert.strictEqual(tree[0].tests.length, 4);
assert.strictEqual(e.groupState(tree[0].tests, results), 'failed');
assert.deepStrictEqual(e.groupTests(tests, 'state', results).map((n) => n.name), ['failed', 'passed', 'notrun']);
assert.deepStrictEqual(e.groupTests(tests, 'duration', results).map((n) => n.name), ['slow', 'fast', 'none']);
assert.strictEqual(e.groupTests(tests, 'class', results).length, 3);
assert.deepStrictEqual(e.groupTests([{ ...test('p', 'N.C.Case(1.5)'), name: 'Case(1.5)' }], 'hierarchy', results)[0].children.map((n) => n.name), ['N']);
const names = { failed: ['Niepowodzenie'], notrun: ['Nie uruchomiono'] };
const pick = (text) => tests.filter((t) => e.matchesFilter(t, results, text, names)).map((t) => t.fqn + '@' + t.project);
assert.deepStrictEqual(pick('State:Fail'), ['A.B.C.Fails@p']);
assert.deepStrictEqual(pick('state:niepow'), ['A.B.C.Fails@p']);
assert.deepStrictEqual(pick('Class:E'), ['A.D.E.Works@p']);
assert.deepStrictEqual(pick('Project:q'), ['A.B.C.Adds@q']);
assert.deepStrictEqual(pick('Namespace:A.B -adds'), ['A.B.C.Fails@p']);
assert.deepStrictEqual(pick('"run"'), ['Top.Run@p']);

(async () => {
  const project = process.env.TEST_PROJECT;
  if (!project) return console.log('test-engine: ok (set TEST_PROJECT for the run against a project)');
  assert(e.isTestProject(project), 'not a test project');
  const { dll, mtp } = await e.projectInfo(project, { configuration: 'Debug' });
  assert(dll && require('fs').existsSync(dll), `no ${dll}`);
  let found;
  const results = [];
  if (mtp) {
    found = await e.mtpDiscover(dll);
    assert(found.length > 1, 'no tests found');
    await e.mtpRun(dll, found.slice(0, 2), { results: (list) => results.push(...list) }).done;
  } else {
    const vstest = new e.VsTest();
    try {
      found = await vstest.discover([dll]);
      assert(found.length > 1, 'no tests found');
      assert(found.every((t) => t.id && t.fqn && t.source), 'a test without its id, name or source');
      const attached = [];
      await vstest.run({ ids: found.slice(0, 2).map((t) => t.id), debug: true }, { results: (list) => results.push(...list), attach: ({ pid }) => attached.push(pid) && false });
      assert.strictEqual(attached.length, 1, 'a debugged run asks to attach to its test host');
    } finally {
      vstest.dispose();
    }
  }
  assert.deepStrictEqual([...new Set(results.map((r) => r.id))].sort(), found.slice(0, 2).map((t) => t.id).sort());
  console.log('test-engine: ok against', project, `(${mtp ? 'Testing Platform' : 'VSTest'}, ${found.length} tests)`);
})().catch((err) => { console.error(err); process.exit(1); });
