// Runs test/suite.js inside a real editor on a real solution:
//   EDITOR_EXE=<VSCodium.exe> WORKSPACE=<solution folder> node test/runTest.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const exe = process.env.EDITOR_EXE;
  const workspace = process.env.WORKSPACE;
  if (!exe || !workspace) throw new Error('Set EDITOR_EXE and WORKSPACE.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'csharpshooter-test-'));
  // The workspace's own tasks (runOn: folderOpen) stay off while the tests run.
  fs.mkdirSync(path.join(profile, 'data', 'User'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'data', 'User', 'settings.json'), JSON.stringify({
    'task.allowAutomaticTasks': 'off',
    ...(process.env.DEBUGGER_PATH ? { 'csharpShooter.debuggerPath': process.env.DEBUGGER_PATH } : {}),
  }));
  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.js'),
      // A profile and extensions folder of its own: only this extension runs.
      launchArgs: [workspace, '--user-data-dir', path.join(profile, 'data'), '--extensions-dir', path.join(profile, 'ext'), '--disable-workspace-trust'],
      extensionTestsEnv: { ...process.env },
    });
  } finally {
    // The editor can hold its profile's files a moment after it exits; a leftover temp folder is no test failure.
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e) {
      console.warn(`Could not remove ${profile}: ${e.message}`);
    }
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
