// Checks the Test Explorer in a real editor on any solution with built test projects (written against a solution with two test projects):
//   EDITOR_EXE=<editor exe> WORKSPACE=<solution folder> SUITE=test/test-explorer-solution-suite.js \
//   TESTS_EXPECT="Contoso.Core.Tests=35,WebApp.Tests=199" TESTS_RUN=Contoso.Core.Tests node test/runTest.js
// TESTS_EXPECT: each test project and how many tests it has (as VS's Test Explorer counts them); TESTS_RUN: the project
// that is run, debugged (its first test, stopped at its first line) and cancelled.
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
  const expect = Object.fromEntries((process.env.TESTS_EXPECT || '').split(',').filter(Boolean).map((p) => p.split('=')).map(([k, v]) => [k, +v]));
  const runName = process.env.TESTS_RUN;
  const api = await vscode.extensions.getExtension('M455YN.csharpshooter').activate();
  const { explorer, ensure } = api.testExplorer;
  const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log(`ok   ${name}`), (e) => { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; });

  await check('Eksplorator testów opens in the bottom panel', async () => {
    await vscode.commands.executeCommand('csharpShooter.tests.show');
    await ensure();
    await until('the view shows', () => explorer.view.visible, 10000);
    const views = vscode.extensions.getExtension('M455YN.csharpshooter').packageJSON.contributes;
    assert(views.viewsContainers.panel.some((c) => c.id === 'csharpShooterTests'), 'no panel container');
    assert.deepStrictEqual(views.views.csharpShooterTests.map((v) => v.id), ['csharpShooter.testExplorer', 'csharpShooter.testDetails']);
  });

  await check('each test project shows as many tests as VS finds, Projekt > namespace > class', () => {
    const counts = Object.fromEntries(explorer.projects.map((p) => [p.name, p.tests.length]));
    console.log('     found:', JSON.stringify(counts));
    for (const [name, n] of Object.entries(expect)) assert.strictEqual(counts[name], n, name);
    const root = explorer.roots.find((n) => n.name === runName);
    assert(root, `no ${runName} in the tree`);
    assert(root.children.every((n) => n.kind === 'namespace') && root.children[0].children.every((n) => n.kind === 'class'));
    assert.strictEqual(explorer.describe(root).lines[0], `Łączna liczba testów: ${expect[runName]}`);
    assert(explorer.tests.filter((x) => x.projectName === runName).every((x) => x.file && x.line > 0), 'a test without its source line');
  });

  const project = () => explorer.projects.find((p) => p.name === runName);

  await check(`Uruchom on ${runName} runs its tests, results coming before the run ends`, async () => {
    explorer.results.clear();
    const root = explorer.roots.find((n) => n.name === runName);
    let before = 0;
    const finished = vscode.commands.executeCommand('csharpShooter.tests.run', root, [root]);
    await until('the first result', () => explorer.results.size > 0 && explorer.running, 300000).then(() => { before = explorer.results.size; }, () => {});
    await finished;
    const mine = project().tests;
    const states = mine.map((x) => explorer.results.get(x.key)?.outcome);
    console.log('     results:', JSON.stringify(states.reduce((a, s) => ({ ...a, [s]: (a[s] || 0) + 1 }), {})), `(${before} while running)`);
    assert(states.every(Boolean), 'a test without a result');
    assert(before > 0, 'no result came while the run was going');
    assert.strictEqual(explorer.running, false);
  });

  await check('a test\'s summary shows its source and duration', () => {
    const node = [...explorer.nodes.values()].find((n) => n.kind === 'test' && n.test.projectName === runName);
    const d = explorer.describe(node);
    assert.strictEqual(d.kind, 'test');
    assert(d.source.file, 'no source');
    assert(d.duration, 'no duration');
  });

  await check('Debuguj stops at a breakpoint in the test and the run ends after Kontynuuj', async () => {
    const test = project().tests.slice().sort((a, b) => a.fqn.localeCompare(b.fqn))[0];
    const uri = vscode.Uri.file(test.file);
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(test.line - 1, 0)), true);
    vscode.debug.addBreakpoints([breakpoint]);
    const stopped = new Promise((resolve) => {
      const d = vscode.debug.registerDebugAdapterTrackerFactory('csharpshooter', { createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => {
        if (m.type === 'event' && m.event === 'stopped' && m.body.reason === 'breakpoint') { d.dispose(); resolve('breakpoint'); }
      } }) });
    });
    explorer.results.delete(test.key);
    const finished = explorer.runIn([test], true);
    try {
      assert.strictEqual(await Promise.race([stopped, sleep(180000).then(() => 'timeout')]), 'breakpoint');
      await until('the stop is shown', () => vscode.debug.activeStackItem, 20000);
      await vscode.commands.executeCommand('workbench.action.debug.continue');
      await Promise.race([finished, sleep(60000).then(() => { throw new Error('the run did not end'); })]);
      assert(explorer.results.get(test.key), 'no result');
    } finally {
      vscode.debug.removeBreakpoints([breakpoint]);
    }
  });

  await check('Anuluj ends a run', async () => {
    const finished = explorer.runIn(project().tests, false);
    await until('run started', () => explorer.runner, 300000);
    const cancelled = Date.now();
    explorer.cancel();
    await finished;
    assert.strictEqual(explorer.running, false);
    assert(Date.now() - cancelled < 10000, `the run ended ${Date.now() - cancelled} ms after Anuluj`);
  });
}

module.exports = { run };
