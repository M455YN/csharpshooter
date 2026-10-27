// Checks the Test Explorer in a real editor, on a workspace whose solution has one xunit test project built in Debug with
// tests Adds, Fails (fails), Skipped, Theory (two InlineData rows) and Slow in Sample.Tests.Math.CalcTests, and Works in
// Sample.Tests.OtherTests:
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/test-explorer-suite.js node test/runTest.js
const vscode = require('vscode');
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(300);
  }
}

async function run() {
  const api = await vscode.extensions.getExtension('M455YN.csharpshooter').activate();
  const { explorer, ensure } = api.testExplorer;
  await vscode.commands.executeCommand('csharpShooter.tests.show');
  await ensure();
  const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`ok   ${name}`), (e) => { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; });
  const names = (nodes) => nodes.map((n) => n.name);

  await check('the tests of the built project are found, as Projekt > namespace > class', () => {
    assert.strictEqual(explorer.tests.length, 7);
    assert.deepStrictEqual(names(explorer.roots), ['Sample.Tests']);
    const namespaces = explorer.roots[0].children;
    assert.deepStrictEqual(names(namespaces), ['Sample.Tests', 'Sample.Tests.Math']);
    assert.deepStrictEqual(names(namespaces[1].children[0].children), ['Adds', 'Fails', 'Skipped', 'Slow', 'Theory(x: 1)', 'Theory(x: 2)']);
    assert.strictEqual(explorer.view.message, undefined);
  });

  await check('a test has a not-run icon and its fully qualified name as tooltip', () => {
    const item = explorer.getTreeItem(explorer.roots[0].children[1].children[0].children[0]);
    assert.strictEqual(item.iconPath.id, 'circle-outline');
    assert.strictEqual(item.tooltip, 'Sample.Tests.Math.CalcTests.Adds');
  });

  await check('grouping by state, class and duration', async () => {
    for (const mode of ['state', 'class', 'duration', 'project', 'namespace', 'hierarchy']) { explorer.mode = mode; explorer.refresh(); assert(explorer.roots.length > 0, mode); }
    explorer.mode = 'state'; explorer.refresh();
    assert.deepStrictEqual(names(explorer.roots), ['Nie uruchomiono']);
    explorer.mode = 'hierarchy'; explorer.refresh();
  });

  await check('a filter narrows the tree and the empty text appears when nothing is left', () => {
    explorer.filter = 'Class:OtherTests'; explorer.refresh();
    assert.strictEqual(explorer.visible().length, 1);
    explorer.filter = 'State:Failed'; explorer.refresh();
    assert.strictEqual(explorer.view.message, 'Wszystkie testy zostały odfiltrowane w tym widoku.');
    explorer.filter = ''; explorer.refresh();
  });

  await check('Uruchom wszystkie runs the tests and shows results', async () => {
    await vscode.commands.executeCommand('csharpShooter.tests.runAll');
    const by = (name) => explorer.tests.find((x) => x.fqn.endsWith(`.${name}`));
    const state = (name) => explorer.results.get(by(name).key)?.outcome;
    assert.strictEqual(state('Adds'), 'passed');
    assert.strictEqual(state('Fails'), 'failed');
    assert.strictEqual(state('Skipped'), 'skipped');
    assert.strictEqual(state('Theory'), 'passed');
    assert.match(explorer.results.get(by('Fails').key).message, /Assert\.Equal\(\) Failure/);
    assert.match(explorer.view.description, /✔ 5 ✖ 1 ⊘ 1/);
    assert.strictEqual(explorer.getTreeItem(explorer.nodes.get(`/project:${by('Fails').project}`)).iconPath.id, 'error');
  });

  await check('the details show the failed test, its source and its stack trace links', async () => {
    const fails = [...explorer.nodes.values()].find((n) => n.kind === 'test' && n.name === 'Fails');
    const d = explorer.describe(fails);
    assert.strictEqual(d.kind, 'test');
    assert.strictEqual(d.state, 'Niepowodzenie');
    assert.match(d.source.text, /CalcTests\.cs wiersz 6$/);
    assert(d.stack.links.length > 0);
    assert.strictEqual(d.labels.stack, 'Ślad stosu');
    const group = explorer.describe(explorer.roots[0]);
    assert.strictEqual(group.lines[0], 'Łączna liczba testów: 7');
  });

  await check('Przejdź do testu opens the method', async () => {
    const fails = [...explorer.nodes.values()].find((n) => n.kind === 'test' && n.name === 'Fails');
    await explorer.openTest(fails);
    assert.match(vscode.window.activeTextEditor.document.fileName, /CalcTests\.cs$/);
    assert.strictEqual(vscode.window.activeTextEditor.selection.active.line, 5);
  });

  await check('Uruchom on a class runs only its tests; a test in context runs from the editor', async () => {
    explorer.results.clear();
    const cls = [...explorer.nodes.values()].find((n) => n.kind === 'class' && n.name === 'OtherTests');
    await vscode.commands.executeCommand('csharpShooter.tests.run', cls, [cls]);
    assert.strictEqual(explorer.results.size, 1);
    const editor = vscode.window.activeTextEditor; // CalcTests.cs, cursor on Fails
    editor.selection = new vscode.Selection(new vscode.Position(5, 30), new vscode.Position(5, 30));
    const found = await explorer.testsInContext();
    assert.deepStrictEqual(found.map((x) => x.fqn), ['Sample.Tests.Math.CalcTests.Fails']);
  });

  await check('Debuguj stops at a breakpoint in the test', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.window.activeTextEditor.document.uri);
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(4, 0)), true); // Adds
    vscode.debug.addBreakpoints([breakpoint]);
    const reasons = [];
    const stopped = new Promise((resolve) => {
      const d = vscode.debug.registerDebugAdapterTrackerFactory('csharpshooter', { createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => {
        if (m.type === 'event' && m.event === 'stopped') { reasons.push(m.body.reason); if (m.body.reason === 'breakpoint') { d.dispose(); resolve('breakpoint'); } }
      } }) });
    });
    const adds = explorer.tests.find((x) => x.fqn.endsWith('.Adds'));
    const finished = explorer.runIn([adds], true);
    const reason = await Promise.race([stopped, sleep(60000).then(() => 'timeout')]);
    console.log('stops:', reasons.join(','));
    assert.strictEqual(reason, 'breakpoint');
    // As a person presses F5: once the editor shows where it stopped.
    await until('the stop is shown', () => vscode.debug.activeStackItem, 20000);
    await vscode.commands.executeCommand('workbench.action.debug.continue');
    await finished;
    assert.strictEqual(explorer.results.get(adds.key).outcome, 'passed');
    vscode.debug.removeBreakpoints([breakpoint]);
  });

  await check('Anuluj ends a run', async () => {
    const slow = explorer.tests.find((x) => x.fqn.endsWith('.Slow'));
    const finished = explorer.runIn([slow], false);
    await until('run started', () => explorer.runner);
    explorer.cancel();
    await finished;
    assert.strictEqual(explorer.running, false);
  });
}

module.exports = { run };
