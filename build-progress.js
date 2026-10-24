// What a build and a start are doing, in a notification at the bottom right, as VS says it in its status bar: the build's
// stages read from MSBuild's file log as it is written (the terminal keeps MSBuild's own output), then the start, the
// wait for the app to listen, the browser.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');

// MSBuild's targets that every SDK project runs and that say nothing a person needs; any other target with output (a
// project's own PreBuild, a gulp target) is shown.
const QUIET_TARGETS = new Set(['AddPrunePackageReferences', 'GenerateTargetFrameworkMonikerAttribute', 'CoreResGen', 'CopyFilesToOutputDirectory',
  'GenerateBuildDependencyFile', 'GenerateBuildRuntimeConfigurationFiles', 'CreateAppHost', 'IncrementalClean', 'ResolvePackageAssets',
  'GenerateRuntimeConfigurationFiles', 'GenerateNETCompatibleDefineConstants', 'ResolveAssemblyReferences', 'PrepareForBuild', 'GetCopyToOutputDirectoryItems',
  'CopyAppConfigFile', 'ResolveTargetingPackAssets', 'ProcessFrameworkReferences', 'GenerateAssemblyInfo', 'CreateGeneratedAssemblyInfoInputsCacheFile',
  'CoreGenerateAssemblyInfo', 'ResolveProjectStaticWebAssets', 'GenerateStaticWebAssetsManifest', 'GenerateStaticWebAssetsDevelopmentManifest',
  'ResolveBuildCompressedStaticWebAssets', 'ResolveStaticWebAssetsConfiguration', 'GenerateMSBuildEditorConfigFileShouldRun',
  'GenerateMSBuildEditorConfigFileCore', 'GenerateGlobalUsings', 'GetFrameworkPaths', 'GenerateTargetPlatformDefineConstants', 'CheckForDuplicateItems',
  'ResolveLockFileReferences', 'ResolveLockFileAnalyzers', 'GenerateRazorTargetAssemblyInfo', 'RazorCoreGenerate', 'RazorCoreCompile']);

/** A notification that stays while a build and a start go on; report() changes its line, done() closes it. */
function launchProgress(title) {
  let report = () => {};
  let finish;
  const ended = new Promise((resolve) => (finish = resolve));
  const tokenSource = new vscode.CancellationTokenSource();
  const shown = new Promise((resolve) => {
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => {
        tokenSource.cancel();
        finish();
      });
      report = (message) => progress.report({ message });
      resolve();
      return ended;
    });
  });
  const handle = {
    lines: [], // what it said, in order (for the tests)
    token: tokenSource.token,
    report: (message) => {
      handle.lines.push(message);
      shown.then(() => report(message));
    },
    done: () => finish(),
  };
  // A start that never gets as far as the browser (no profile URL, the session gone) does not leave it up for long.
  setTimeout(() => finish(), 10 * 60 * 1000).unref?.();
  return handle;
}

/** MSBuild's file logger, to a temporary file: the argument for dotnet build and the file. */
function buildLog() {
  const file = path.join(os.tmpdir(), `csharpshooter-build-${process.pid}-${Date.now()}.log`);
  return { file, arg: `-flp:logfile=${file};verbosity=normal;encoding=utf-8` };
}

/** Reads the file log as MSBuild writes it, and says what matters: restore, each project's own targets, compiling, a
 *  project done, errors and warnings. Lines are matched by their shape, not their words (MSBuild writes in the system's
 *  language). Returns stop(), which reads the rest and removes the file; counts says how many errors and warnings. */
function followBuildLog(file, report) {
  const projectOf = new Map(); // MSBuild node -> project name
  const counts = { errors: 0, warnings: 0, built: [] };
  const seen = new Set(); // targets said, errors and warnings counted (MSBuild repeats them: restore, the summary)
  let node = ''; // the node of the last "N>" line; the lines under it carry no prefix
  let offset = 0;
  let rest = '';
  const suffix = () => [counts.errors ? `błędy: ${counts.errors}` : '', counts.warnings ? `ostrzeżenia: ${counts.warnings}` : ''].filter(Boolean).join(', ');
  const say = (text) => report(suffix() ? `${text} (${suffix()})` : text);
  const name = (p) => path.basename(p).replace(/\.\w+proj$/, '');
  const line = (l) => {
    let m = /^\s*(\d+)(?::\d+)?>/.exec(l);
    if (m) node = m[1];
    // 1>Project "D:\x\A.csproj" (1) is building "D:\x\B.csproj" (2) ...  /  1>Projekt „D:\x\A.csproj” (1) kompiluje „D:\x\B.csproj” (2) ...
    for (const p of l.matchAll(/[„"“]([^"”„]+?\.\w+proj)[”"]\s*\((\d+)(?::\d+)?\)/g)) projectOf.set(p[2], name(p[1]));
    // 1>Project "D:\x\A.csproj" on node 1 (default targets).
    m = /^\s*\d+(?::\d+)?>\S+ [„"“]([^"”„]+?\.\w+proj)[”"]/.exec(l);
    if (m && !projectOf.has(node)) projectOf.set(node, name(m[1]));
    m = /^\s*(?:\d+(?::\d+)?>)?([A-Za-z]\w*):\s*$/.exec(l);
    if (m) {
      const target = m[1];
      const project = projectOf.get(node) || '';
      if (target === 'Restore') say('Przywracanie pakietów NuGet…');
      else if (target === 'CoreCompile') say(`Kompilowanie ${project}…`);
      else if (!QUIET_TARGETS.has(target) && !seen.has(`${project}:${target}`)) {
        seen.add(`${project}:${target}`);
        say(`${project}: ${target}…`);
      }
      return;
    }
    m = /^\s+(\S+) -> (\S.*\.(dll|exe))\s*$/i.exec(l);
    if (m) {
      if (!counts.built.includes(m[1])) counts.built.push(m[1]);
      say(`${m[1]} — skompilowano`);
      return;
    }
    // N>path(12,5): error CS1002: ...; each once (restore and the summary at the end repeat them).
    m = /^\s*\d+(?::\d+)?>(.*: (error|warning) [A-Z]+\d+:.*)$/.exec(l);
    if (m && !seen.has(m[1].trim())) {
      seen.add(m[1].trim());
      counts[m[2] === 'error' ? 'errors' : 'warnings']++;
    }
  };
  const read = () => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return;
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (rest + buffer.toString('utf8')).split(/\r?\n/);
      rest = lines.pop();
      lines.forEach(line);
    } catch {
      // not there yet
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  const timer = setInterval(read, 250);
  return {
    counts,
    stop() {
      clearInterval(timer);
      read();
      fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { launchProgress, buildLog, followBuildLog };
