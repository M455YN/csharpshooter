// The Test Explorer's engine against a TRX log and a few names, and (with TEST_PROJECT set to a built xunit/MSTest project
// file) against that project: node test/test-engine.js
const assert = require('assert');
const e = require('../test-engine');

const trx = `<TestRun xmlns="x"><Results>
<UnitTestResult testId="1" testName="A.B.C.Adds" duration="00:00:00.0135275" outcome="Passed" />
<UnitTestResult testId="2" testName="A.B.C.Fails" duration="00:00:01.5" outcome="Failed"><Output><ErrorInfo><Message>x &lt; y&#xD;
z</Message><StackTrace>   at A.B.C.Fails() in C:\s\A.cs:line 6</StackTrace></ErrorInfo></Output></UnitTestResult>
<UnitTestResult testId="3" testName="A.B.C.Theory(x: 1)" duration="00:00:00.1" outcome="Passed" />
<UnitTestResult testId="4" testName="A.B.C.Theory(x: 2)" duration="00:00:00.2" outcome="Failed"><Output><StdOut>out</StdOut></Output></UnitTestResult>
<UnitTestResult testId="5" testName="A.B.C.Skipped" duration="00:00:00" outcome="NotExecuted" />
</Results><TestDefinitions>
<UnitTest name="A.B.C.Adds" id="1"><TestMethod className="A.B.C" name="Adds" /></UnitTest>
<UnitTest name="A.B.C.Fails" id="2"><TestMethod className="A.B.C" name="Fails" /></UnitTest>
<UnitTest name="A.B.C.Theory(x: 1)" id="3"><TestMethod className="A.B.C" name="Theory" /></UnitTest>
<UnitTest name="A.B.C.Theory(x: 2)" id="4"><TestMethod className="A.B.C" name="Theory" /></UnitTest>
<UnitTest name="A.B.C.Skipped" id="5"><TestMethod className="A.B.C" name="Skipped" /></UnitTest>
</TestDefinitions></TestRun>`;
const r = e.parseTrx(trx);
assert.deepStrictEqual([...r.keys()], ['A.B.C.Adds', 'A.B.C.Fails', 'A.B.C.Theory', 'A.B.C.Skipped']);
assert.strictEqual(r.get('A.B.C.Adds').duration, 14);
assert.strictEqual(r.get('A.B.C.Fails').message, 'x < y\r\nz');
assert.strictEqual(r.get('A.B.C.Fails').duration, 1500);
assert.strictEqual(r.get('A.B.C.Theory').outcome, 'failed');
assert.strictEqual(r.get('A.B.C.Theory').duration, 300);
assert.strictEqual(r.get('A.B.C.Theory').stdout, 'out');
assert.strictEqual(r.get('A.B.C.Skipped').outcome, 'skipped');

assert.strictEqual(e.filterFor(['A.B(x)', 'C.D']), String.raw`FullyQualifiedName=A.B\(x\)|FullyQualifiedName=C.D`);
assert.strictEqual(e.chunks(Array.from({ length: 10 }, () => 'x'.repeat(100)), 400).length, 4);
assert.deepStrictEqual(e.splitName('A.B.C.Adds'), { fullClass: 'A.B.C', namespace: 'A.B', className: 'C', method: 'Adds' });
assert.deepStrictEqual(e.splitName('C.Adds'), { fullClass: 'C', namespace: '', className: 'C', method: 'Adds' });
assert.deepStrictEqual(e.stackLinks(String.raw`at X() in C:\s\A.cs:line 6` + '\r\nat Y()').map((l) => [l.file, l.line]), [[String.raw`C:\s\A.cs`, 6]]);

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
  const settings = { configuration: 'Debug' };
  const dll = await e.targetPath(project, settings);
  assert(dll && require('fs').existsSync(dll), `no ${dll}`);
  const listed = await e.listTests(dll);
  assert(listed.length > 1, 'no tests found');
  const out = await e.runTests({ project, args: ['-c', 'Debug'], fqns: listed.slice(0, 2), noBuild: true }).done;
  assert.deepStrictEqual([...out.results.keys()].sort(), listed.slice(0, 2).sort());
  console.log('test-engine: ok against', project, `(${listed.length} tests)`);
})().catch((err) => { console.error(err); process.exit(1); });
