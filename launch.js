// F5 as Visual Studio does it: each runnable project's launch profiles (Properties/launchSettings.json) are debug
// configurations; the project builds first, runs with the profile's environment and URLs, and the browser opens once the
// app listens. A launch.json entry can name them too: { "type": "csharpshooter", "request": "launch",
// "project": "${workspaceFolder}/WebApp/WebApp.csproj", "launchProfile": "WebApp Development" }.
const vscode = require('vscode');
const { t } = require('./l10n');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { launchProgress, buildLog, followBuildLog } = require('./build-progress');
const { buildArgs } = require('./startup');
const upToDate = require('./up-to-date');
const iisExpress = require('./iis-express');

const TYPE = 'csharpshooter';

/** JSON with comments and trailing commas, as VS writes and reads launchSettings.json and appsettings.json. */
function parseJsonc(text) {
  return JSON.parse(text.replace(/^\uFEFF/, '')
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
    .replace(/,(\s*[}\]])/g, '$1'));
}

function readLaunchSettings(project) {
  const file = path.join(path.dirname(project), 'Properties', 'launchSettings.json');
  if (!fs.existsSync(file)) return null;
  return parseJsonc(fs.readFileSync(file, 'utf8'));
}

/** Profiles that run the project: Project on Kestrel, IISExpress under IIS Express as VS runs it (iis-express.js), or on
 *  Kestrel at the IIS Express URLs where IIS Express is not installed. Executable, Docker and the rest are not this
 *  debugger's. */
function runnableProfiles(project) {
  const settings = readLaunchSettings(project);
  return Object.entries(settings?.profiles || {})
    .filter(([, p]) => p.commandName === 'Project' || p.commandName === 'IISExpress')
    .map(([name, p]) => ({ name, profile: p, iis: settings.iisSettings?.iisExpress }));
}

function urlsOf({ profile, iis }) {
  if (profile.commandName === 'IISExpress' && iis) {
    const http = iis.applicationUrl?.replace(/\/$/, '');
    const https = iis.sslPort ? `https://localhost:${iis.sslPort}` : null;
    return [https, http].filter(Boolean);
  }
  return (profile.applicationUrl || '').split(';').map((u) => u.trim()).filter(Boolean);
}

/** Asks MSBuild what the build writes, so AssemblyName, OutputPath and target framework are the project's own. */
function msbuildProperties(project, settings, framework) {
  return new Promise((resolve, reject) => {
    // IntermediateOutputPath and CleanFile: where the build lists what it wrote, which the up-to-date check keeps.
    execFile('dotnet', ['msbuild', project, '-getProperty:TargetPath', '-getProperty:RunCommand', '-getProperty:IntermediateOutputPath', '-getProperty:CleanFile', '-getProperty:AspNetCoreHostingModel', `-p:Configuration=${settings.configuration}`,
      ...buildArgs(settings).filter((a) => a.startsWith('-p:')),
      ...(framework ? [`-p:TargetFramework=${framework}`] : [])],
      { cwd: path.dirname(project), windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`dotnet msbuild ${path.basename(project)}: ${stderr || stdout || error.message}`));
        try {
          resolve(JSON.parse(stdout).Properties);
        } catch {
          reject(new Error(`dotnet msbuild ${path.basename(project)} said: ${stdout}`));
        }
      });
  });
}

// A task building, cleaning, publishing or restoring .NET projects (the Solution Explorer's, another start's, tasks.json's,
// the NuGet page's), which writes what a build here reads and makes.
const BUILDING = /\bdotnet(\.exe)?["']?\s+(build|msbuild|clean|publish|restore|pack|test|add|remove)\b/i;
const buildsUnderWay = () => vscode.tasks.taskExecutions.filter((e) => e.task.definition?.type === 'csharpShooter.nuget' || BUILDING.test(require('./task-runner').commandText(e.task.execution)));

/** Waits for the builds under way to end, as Passenger 0.2.1 does, where a second build would fight the first over its
 *  files; then the check reads what they left. */
async function waitForBuilds(progress) {
  if (!buildsUnderWay().length) return;
  progress.report(t('Waiting for the build under way to end…'));
  await new Promise((resolve) => {
    const subscriptions = [];
    const settle = () => (!buildsUnderWay().length || progress.token.isCancellationRequested) && (subscriptions.forEach((s) => s.dispose()), resolve());
    subscriptions.push(vscode.tasks.onDidEndTask(settle), progress.token.onCancellationRequested(settle));
  });
}

/** Builds the project in a task the person sees, as VS builds on F5, saying in `progress` what the build is doing;
 *  resolves with whether it succeeded, the errors it had, and the up-to-date check that came first (`upToDate` when it
 *  found nothing to build, with the project's properties its last build's launch read). */
async function build(project, settings, framework, progress) {
  // Before Build bindings of the project's gulpfiles (csharpShooter.taskRunner.buildBindings), as VS runs them.
  const { buildBindings } = require('./task-runner');
  await waitForBuilds(progress);
  if (progress.token.isCancellationRequested) return { ok: false, errors: 0 };
  progress.report(t('Build started…'));
  if (!(await buildBindings('BeforeBuild', path.dirname(project)))) return { ok: false, errors: 0 };
  const checked = await upToDate.check(project, settings, framework);
  if (checked.holds) {
    progress.report(t('Build: up to date'));
    return { ok: await buildBindings('AfterBuild', path.dirname(project)), errors: 0, checked, upToDate: true };
  }
  // A file of the project saved while it builds, or before the launch keeps what the build left, may have come too late
  // for the build: then it does not stand.
  const saves = vscode.workspace.onDidSaveTextDocument((d) => upToDate.reads(checked, d.uri.fsPath) && (checked.savedMeanwhile = true));
  checked.unwatch = () => saves.dispose();
  return { ...(await runBuild(project, settings, framework, progress, buildBindings)), checked };
}

async function runBuild(project, settings, framework, progress, buildBindings) {
  const log = buildLog();
  const task = new vscode.Task({ type: 'shell', task: `build ${path.basename(project)}` }, vscode.TaskScope.Workspace,
    `build ${path.basename(project, '.csproj')}`, 'CSharpShooter',
    new vscode.ShellExecution('dotnet', ['build', project, ...buildArgs(settings), ...(framework ? ['-f', framework] : []), { value: log.arg, quoting: vscode.ShellQuoting.Strong }], { cwd: path.dirname(project) }), '$msCompile');
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  const following = followBuildLog(log.file, progress.report);
  const execution = await vscode.tasks.executeTask(task);
  const cancel = progress.token.onCancellationRequested(() => execution.terminate());
  const exitCode = await new Promise((resolve) => {
    const done = vscode.tasks.onDidEndTaskProcess((e) => e.execution === execution && (done.dispose(), resolve(e.exitCode)));
  });
  cancel.dispose();
  following.stop();
  const ok = exitCode === 0 && !progress.token.isCancellationRequested && (await buildBindings('AfterBuild', path.dirname(project)));
  if (ok) progress.report(following.counts.warnings ? t('Build succeeded (warnings: {0})', following.counts.warnings) : t('Build succeeded'));
  return { ok, errors: following.counts.errors };
}

/** Runnable projects of the solution: Exe output or a web SDK, which is what has launch profiles to run. */
async function runnableProjects() {
  const files = await vscode.workspace.findFiles('**/*.csproj', '**/{node_modules,bin,obj}/**');
  // findFiles answers in no fixed order; sorted, the startup project's fallback (the first web project) is the same project
  // for the status bar, the Solution Explorer and F5, which each ask on their own.
  return files.map((u) => u.fsPath).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).filter((p) => {
    const text = fs.readFileSync(p, 'utf8');
    return /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(text) || /<OutputType>\s*(Win)?Exe\s*</i.test(text);
  });
}

function configurationFor(project, name) {
  return { type: TYPE, request: 'launch', name: `${path.basename(project, '.csproj')}: ${name}`, project, launchProfile: name };
}

class LaunchProfiles {
  constructor(state) {
    this.state = state; // what tests read: the last build and the URL the browser was sent to
  }

  /** The Run and Debug list: one entry per project and profile, under ".NET (CSharpShooter)". */
  async provideDebugConfigurations() {
    const configs = [];
    for (const project of await runnableProjects()) {
      for (const { name } of runnableProfiles(project)) configs.push(configurationFor(project, name));
      if (!runnableProfiles(project).length) configs.push(configurationFor(project, null));
    }
    return configs;
  }

  /** F5 with no launch.json: the active file's project, or a choice, and its first profile. */
  async resolveDebugConfiguration(folder, config) {
    if (config.type || config.request || config.name) return config;
    const projects = await runnableProjects();
    const active = vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase();
    let project = projects.find((p) => active?.startsWith(path.dirname(p).toLowerCase() + path.sep));
    project ??= projects.length === 1 ? projects[0]
      : (await vscode.window.showQuickPick(projects.map((p) => ({ label: path.basename(p, '.csproj'), project: p })), { placeHolder: t('Project to run') }))?.project;
    if (!project) return undefined;
    const profiles = runnableProfiles(project);
    const picked = profiles.length > 1
      ? (await vscode.window.showQuickPick(profiles.map((p) => p.name), { placeHolder: t('Launch profile') }))
      : profiles[0]?.name;
    if (profiles.length > 1 && !picked) return undefined;
    return configurationFor(project, picked ?? null);
  }

  /** A configuration that names a project: built, its program found, its profile's environment and URLs applied. */
  async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    if (this.loading?.()) {
      vscode.window.showWarningMessage(t('The solution is still loading: {0} Starting and running tests are possible once it is ready.', this.loading()));
      return undefined;
    }
    const asked = config;
    // "CSharpShooter": the startup project with its active profile and framework, as VS's F5 runs it.
    if (config.request === 'launch' && config.startupProject && this.startup) {
      const now = await this.startup.current();
      if (!now) {
        vscode.window.showErrorMessage(t('No runnable project in this workspace.'));
        return undefined;
      }
      config = { ...config, project: now.project, launchProfile: now.profile ?? null, framework: config.framework ?? now.framework,
        name: `${path.basename(now.project, '.csproj')}: ${now.profile ?? path.basename(now.project, '.csproj')}` };
    }
    if (config.request !== 'launch' || !config.project) return config;
    const project = path.resolve(folder?.uri.fsPath || '', config.project);
    const key = project.toLowerCase();
    const state = this.state;
    state.lastStart = { folder, config: asked }; // what Restart starts again
    state.starting ||= new Map();
    state.programs ||= new Map();
    // A start of the same project still going (its build, or the wait for its app) gives way to this one, and its app
    // still running from the start before (Restart, or F5 again) is stopped, so the build can write its files; as VS's
    // Restart does.
    const before = state.starting.get(key);
    if (before) {
      before.progress.cancel();
      await before.finished;
    }
    // Not while a debug session of it is still on: VS Code's own restart (the debug toolbar's) resolves before it ends
    // the session, and gives up when the session ends under it.
    const live = [...(state.sessions || [])].some((s) => s.configuration.project && path.resolve(s.configuration.project).toLowerCase() === key);
    state.lastStopped = live ? [] : await stopRunning(state.programs.get(key));
    // Its IIS Express, whose in-process app holds the build's files, from a start before or one VS Code left going.
    if (!live && iisExpress.available() && runnableProfiles(project).some((p) => p.profile.commandName === 'IISExpress')) {
      state.lastStopped.push(...(await iisExpress.stopFor(project)));
    }
    // What it is doing, at the bottom right, until the browser opens (or the start is done when there is none to wait for).
    const progress = launchProgress(config.name || path.basename(project, '.csproj'));
    state.lastProgress = progress;
    let handedOver = false;
    let finish;
    const run = { progress, finished: new Promise((r) => (finish = r)) };
    state.starting.set(key, run);
    state.changed?.fire();
    try {
      return await this.launch(folder, config, project, progress, () => (handedOver = true));
    } finally {
      if (!handedOver) progress.done();
      if (state.starting.get(key) === run) state.starting.delete(key);
      finish();
      state.changed?.fire();
    }
  }

  async launch(folder, config, project, progress, handOver) {
    // The configuration launch.json names, else the solution's (the status bar's) as the .sln maps it for this project.
    const settings = config.configuration ? { configuration: config.configuration, platform: config.platform }
      : (await this.startup?.buildSettings(project)) || { configuration: 'Debug' };
    let built;
    let props;
    try {
      if (config.build !== false) {
        built = await build(project, settings, config.framework, progress);
        this.state.lastBuild = { project, ok: built.ok, upToDate: !!built.upToDate };
        if (!built.ok) {
          if (!progress.token.isCancellationRequested) {
            vscode.window.showErrorMessage(built.errors ? t("Build of {0} failed ({1} errors); see the task's terminal and Problems.", path.basename(project), built.errors) : t("Build of {0} failed; see the task's terminal and Problems.", path.basename(project)));
          }
          return undefined;
        }
      }
      if (progress.token.isCancellationRequested) return undefined; // a Restart came in meanwhile
      // Nothing built: the properties the last build's launch read still hold, as the project's files do.
      props = built?.upToDate ? built.checked.props : undefined;
      if (!props) {
        progress.report(t('Reading the project properties…'));
        props = await msbuildProperties(project, settings, config.framework);
      }
      if (built?.ok && !built.upToDate) built.kept = !built.checked.savedMeanwhile && !progress.token.isCancellationRequested && upToDate.built(built.checked, props);
    } finally {
      built?.checked?.unwatch?.();
      if (built?.checked && !built.upToDate && !built.kept) upToDate.forget(built.checked);
    }
    const entry = config.launchProfile ? runnableProfiles(project).find((p) => p.name === config.launchProfile) : undefined;
    if (config.launchProfile && !entry) {
      vscode.window.showErrorMessage(t('No launch profile "{0}" in {1} that runs here.', config.launchProfile, path.basename(project)));
      return undefined;
    }
    if (entry?.profile.commandName === 'IISExpress' && iisExpress.available()) return this.launchIisExpress(config, project, entry, props, progress, handOver);
    const profile = entry?.profile || {};
    const urls = entry ? urlsOf(entry) : [];
    const env = { ...(profile.environmentVariables || {}), ...(config.env || {}) };
    if (urls.length && !env.ASPNETCORE_URLS) env.ASPNETCORE_URLS = urls.join(';');
    const args = config.args ?? (profile.commandLineArgs ? profile.commandLineArgs.split(' ').filter(Boolean) : []);
    // Another process on the profile's port (an earlier run left going) keeps the app from listening there, and would
    // pass for it to the browser's wait below.
    const portBusy = urls[0] && (await accepts(urls[0]));
    if (portBusy) vscode.window.showWarningMessage(t('{0} is already in use by another process; {1} may not start there.', urls[0], path.basename(project, '.csproj')));
    const resolved = {
      ...config,
      program: config.program || props.TargetPath,
      cwd: config.cwd || (profile.workingDirectory ? path.resolve(path.dirname(project), profile.workingDirectory) : path.dirname(project)),
      args,
      env,
      // The browser, as VS opens it: once the app says it listens, at the profile's launchUrl.
      __browser: profile.launchBrowser && config.launchBrowser !== false ? { base: urls[0], path: profile.launchUrl || '', portBusy } : undefined,
    };
    if (progress.token.isCancellationRequested) return undefined;
    this.state.programs.set(project.toLowerCase(), resolved.program);
    // Ctrl+F5, as VS's Start Without Debugging: the program in a terminal of its own, no debugger, the browser as F5's.
    if (config.noDebug) {
      handOver();
      await runWithoutDebugging(resolved, this.state, progress);
      return undefined;
    }
    progress.report(t('Starting with the debugger…'));
    // The debug session's tracker says the rest (the wait for the port, the browser) and closes it.
    if (resolved.__browser?.base && !portBusy) {
      handOver();
      const id = String((this.state.progressIds = (this.state.progressIds || 0) + 1));
      (this.state.progresses ||= new Map()).set(id, progress);
      resolved.__progress = id;
    }
    return resolved;
  }

  /** An IISExpress profile as VS runs it: the site written into applicationhost.config, iisexpress.exe started in a task
   *  (its console the task's terminal, as VS's tray icon shows it), and the debugger attached to the app: in-process to
   *  iisexpress.exe itself, which Passenger takes hold of as the module starts its runtime (the browser's first request),
   *  so breakpoints in Startup are hit; out of process to the module's child, once a request has started it. */
  async launchIisExpress(config, project, entry, props, progress, handOver) {
    const state = this.state;
    const { file, site, pool } = iisExpress.writeConfig(project, readLaunchSettings(project).iisSettings);
    const model = iisExpress.webConfig(project, props);
    const program = config.program || props.TargetPath;
    const env = { ...(entry.profile.environmentVariables || {}), ...(config.env || {}), ...iisExpress.launcher(program) };
    const urls = urlsOf(entry);
    const portBusy = urls[0] && (await accepts(urls[0]));
    if (portBusy) vscode.window.showWarningMessage(t('{0} is already in use by another process; {1} may not start there.', urls[0], path.basename(project, '.csproj')));
    const browser = entry.profile.launchBrowser && config.launchBrowser !== false ? { base: urls[0], path: entry.profile.launchUrl || '', portBusy } : undefined;
    if (progress.token.isCancellationRequested) return undefined;
    progress.report(t('Starting IIS Express…'));
    const id = String((state.iisExpressIds = (state.iisExpressIds || 0) + 1));
    const label = config.name || path.basename(project, '.csproj');
    const task = new vscode.Task({ type: 'process', task: label, iisExpress: id }, vscode.TaskScope.Workspace, `${label} (IIS Express)`, 'CSharpShooter',
      new vscode.ProcessExecution(iisExpress.EXE, [`/config:${file}`, `/site:${site}`, `/apppool:${pool}`], { cwd: path.dirname(project), env }));
    task.presentationOptions = { reveal: config.noDebug ? vscode.TaskRevealKind.Always : vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    task.isBackground = true;
    // Its process id, which may be told before executeTask answers: the events are kept until the execution is known.
    const seen = [];
    let check;
    const subscriptions = [
      vscode.tasks.onDidStartTaskProcess((e) => (seen.push({ execution: e.execution, pid: e.processId }), check?.())),
      vscode.tasks.onDidEndTask((e) => (seen.push({ execution: e.execution, pid: undefined }), check?.())),
    ];
    const execution = await vscode.tasks.executeTask(task);
    const pid = await new Promise((resolve) => {
      check = () => {
        const event = seen.find((s) => s.execution === execution);
        if (event) resolve(event.pid);
      };
      check();
    }).finally(() => subscriptions.forEach((s) => s.dispose()));
    (state.iisExpress ||= new Map()).set(id, execution);
    state.lastIisExpress = { file, site, pool, model, pid };
    if (!pid) {
      vscode.window.showErrorMessage(t('IIS Express did not start {0}; see its terminal.', site));
      return undefined;
    }
    this.state.programs.set(project.toLowerCase(), program);
    if (config.noDebug) {
      handOver();
      state.lastRunWithoutDebugging = { name: label, execution };
      try {
        await openWhenListening(browser, execution, state, progress);
      } finally {
        progress.done();
      }
      return undefined;
    }
    let processId = pid;
    if (model === 'outofprocess') {
      progress.report(t('Starting {0} in IIS Express…', path.basename(project, '.csproj')));
      await iisExpress.request(urls[0]);
      processId = await iisExpress.child(pid);
      if (!processId) {
        execution.terminate();
        vscode.window.showErrorMessage(t('IIS Express did not start {0} out of process; see its terminal.', path.basename(project, '.csproj')));
        return undefined;
      }
    }
    if (progress.token.isCancellationRequested) {
      execution.terminate();
      return undefined;
    }
    progress.report(t('Starting with the debugger…'));
    const resolved = { ...config, request: 'attach', processId, __iisExpress: id, __browser: browser };
    if (browser?.base && !portBusy) {
      handOver();
      const progressId = String((state.progressIds = (state.progressIds || 0) + 1));
      (state.progresses ||= new Map()).set(progressId, progress);
      resolved.__progress = progressId;
    }
    return resolved;
  }
}

/** Runs a resolved launch without a debugger: a task running the program (dotnet <dll>, or its apphost), then the
 *  browser once the port answers. The debug session is not started; the task's terminal is the program's console. */
async function runWithoutDebugging(config, state, progress) {
  try {
    await startWithoutDebugging(config, state, progress);
  } finally {
    progress.done();
  }
}

async function startWithoutDebugging(config, state, progress) {
  progress.report(t('Starting without debugging…'));
  const viaDotnet = /\.dll$/i.test(config.program);
  const exec = new vscode.ProcessExecution(viaDotnet ? 'dotnet' : config.program, [...(viaDotnet ? [config.program] : []), ...(config.args || [])],
    { cwd: config.cwd, env: config.env });
  const label = config.name || path.basename(config.program);
  const task = new vscode.Task({ type: 'process', task: label }, vscode.TaskScope.Workspace, label, 'CSharpShooter', exec);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  task.isBackground = true;
  const execution = await vscode.tasks.executeTask(task);
  state.lastRunWithoutDebugging = { name: label, execution };
  await openWhenListening(config.__browser, execution, state, progress);
}

/** Opens the browser once something accepts connections at its base URL, while the task runs. */
async function openWhenListening(browser, execution, state, progress) {
  if (!browser?.base || browser.portBusy) return;
  progress.report(listeningMessage(browser.base));
  for (let i = 0; i < 300 && vscode.tasks.taskExecutions.includes(execution) && !progress.token.isCancellationRequested; i++) {
    if (await accepts(browser.base)) {
      const url = `${browser.base.replace(/\/$/, '')}/${browser.path.replace(/^\//, '')}`;
      progress.report(t('Opening the browser…'));
      state.browserUrl = url;
      if (!process.env.CSHARPSHOOTER_NO_BROWSER) vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Stops the processes running `program` (a project's .dll, or its apphost beside it) and waits until they have gone;
 *  gives their ids. */
async function stopRunning(program) {
  if (!program) return [];
  const dll = path.resolve(program).toLowerCase();
  const exe = dll.replace(/\.dll$/, process.platform === 'win32' ? '.exe' : '');
  if (process.platform === 'win32') {
    const quote = (v) => `'${v.replace(/'/g, "''")}'`;
    const script = `$d = ${quote(dll)}; $e = ${quote(exe)}
$p = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $e) -or ($_.CommandLine -and $_.CommandLine.ToLower().Contains($d)) })
$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$p | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 15 -ErrorAction SilentlyContinue; $_.ProcessId }`;
    const out = await new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (e, stdout) => resolve(stdout || '')));
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  const out = await new Promise((resolve) => execFile('ps', ['-eo', 'pid=,args='], (e, stdout) => resolve(stdout || '')));
  const pids = out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m && (m[2].toLowerCase().includes(dll) || m[2].toLowerCase().split(' ')[0] === exe)).map((m) => +m[1]);
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
  for (let i = 0; i < 30 && pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await new Promise((r) => setTimeout(r, 500));
  return pids;
}

const listeningMessage = (url) => t('Waiting for the app to listen ({0})…', url);

/** Whether something accepts connections at a URL's host and port. */
function accepts(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const socket = require('net').connect({ host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: +u.port || (u.protocol === 'https:' ? 443 : 80) });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/** Opens the browser once the app listens, once per session: when its port accepts a connection (an app may log nothing
 *  to its console, as the sample app does) or its console says "Now listening on:", whichever comes first. */
function browserOpener(state) {
  return {
    createDebugAdapterTracker(session) {
      const browser = session.configuration.__browser;
      if (!browser) return undefined;
      // The notification of this start, handed over by the resolver: the wait and the browser are said here.
      const id = session.configuration.__progress;
      const progress = state.progresses?.get(id);
      state.progresses?.delete(id);
      let opened = false;
      let polling;
      const open = (base) => {
        if (opened) return;
        opened = true;
        clearInterval(polling);
        const url = `${base.replace(/\/$/, '')}/${browser.path.replace(/^\//, '')}`;
        progress?.report(t('Opening the browser…'));
        progress?.done();
        state.browserUrl = url;
        if (!process.env.CSHARPSHOOTER_NO_BROWSER) vscode.env.openExternal(vscode.Uri.parse(url));
      };
      const stop = () => {
        clearInterval(polling);
        progress?.done();
      };
      return {
        onWillStartSession() {
          progress?.report(listeningMessage(browser.base));
          if (browser.base && !browser.portBusy) polling = setInterval(async () => (await accepts(browser.base)) && open(browser.base), 1000);
        },
        onDidSendMessage(m) {
          if (m.type !== 'event' || m.event !== 'output') return;
          const listening = /Now listening on:\s*(\S+)/.exec(m.body.output || '');
          if (listening) open(browser.base || listening[1]);
        },
        onWillStopSession: stop,
        onExit: stop,
      };
    },
  };
}

/** The "CSharpShooter" entry, for each folder whose launch.json lacks it. VS Code lists only
 *  launch.json's configurations in the Run and Debug dropdown; this one entry is VS's start button: F5 on it runs the
 *  startup project with its active profile, chosen (as in VS's list, which has only the startup project's profiles) from
 *  the status bar's start button. The other projects' profiles stay under ".NET (CSharpShooter)...". */
async function missingProfileEntries() {
  const out = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const have = vscode.workspace.getConfiguration('launch', folder.uri).get('configurations') || [];
    if ((await runnableProjects()).length && !have.some((c) => c.type === TYPE && c.startupProject)) {
      out.push({ folder, entry: require('./startup').startupEntry() });
    }
  }
  return out;
}

/** Adds them to each folder's launch.json (through VS Code's settings, which edit the file in place). */
async function addProfileEntries(missing) {
  for (const folder of new Set(missing.map((m) => m.folder))) {
    const launch = vscode.workspace.getConfiguration('launch', folder.uri);
    const entries = missing.filter((m) => m.folder === folder).map((m) => m.entry);
    // First, so Run and Debug selects it where nothing is selected yet (VS Code then takes the first).
    await launch.update('configurations', [...entries, ...(launch.get('configurations') || [])], vscode.ConfigurationTarget.WorkspaceFolder);
  }
  return missing.map((m) => m.entry.name);
}

/** As a folder opens: asks once (csharpShooter.launchProfilesInLaunchJson: ask), adds silently (always) or leaves it (never). */
async function offerProfileEntries(context) {
  // The entry's earlier name, Polish only, becomes the one both languages read.
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const launch = vscode.workspace.getConfiguration('launch', folder.uri);
    const own = launch.inspect('configurations')?.workspaceFolderValue || [];
    const old = (c) => c.type === TYPE && c.startupProject && c.name === 'Projekt startowy (CSharpShooter)';
    if (own.some(old)) await launch.update('configurations', own.map((c) => (old(c) ? { ...c, name: require('./startup').ENTRY_NAME } : c)), vscode.ConfigurationTarget.WorkspaceFolder);
  }
  const mode = vscode.workspace.getConfiguration('csharpShooter').get('launchProfilesInLaunchJson');
  if (mode === 'never' || context.workspaceState.get('csharpShooter.launchProfilesDeclined')) return;
  const missing = await missingProfileEntries();
  if (!missing.length) return;
  if (mode !== 'always') {
    const names = missing.map((m) => m.entry.name);
    const answer = await vscode.window.showInformationMessage(
      t('Add "{0}" to Run and Debug (.vscode/launch.json)? F5 on it starts the startup project with its active profile, as in Visual Studio.', names[0]),
      t('Add'), t('Not now'), t('Never'));
    if (answer === t('Never')) await context.workspaceState.update('csharpShooter.launchProfilesDeclined', true);
    if (answer !== t('Add')) return;
  }
  await addProfileEntries(missing);
}

function registerLaunch(context) {
  const state = { changed: new vscode.EventEmitter(), sessions: new Set() };
  const provider = new LaunchProfiles(state);
  // Something to restart: an app under the debugger, a start still building, or a run without the debugger.
  const running = () => state.sessions.size > 0 || state.starting?.size > 0
    || (!!state.lastRunWithoutDebugging && vscode.tasks.taskExecutions.includes(state.lastRunWithoutDebugging.execution));
  context.subscriptions.push(state.changed, vscode.tasks.onDidStartTask(() => state.changed.fire()), vscode.tasks.onDidEndTask(() => state.changed.fire()),
    vscode.debug.onDidStartDebugSession((s) => s.type === TYPE && (state.sessions.add(s), state.changed.fire())),
    vscode.debug.onDidTerminateDebugSession((s) => state.sessions.delete(s) && state.changed.fire()),
    // IIS Express ends with the debugging of its app, as VS stops it, so the next build can write what the app held.
    vscode.debug.onDidTerminateDebugSession((s) => s.configuration.__iisExpress && state.iisExpress?.get(s.configuration.__iisExpress)?.terminate()),
    // Uruchom ponownie, as VS's: the app under the debugger ended first (VS Code's own restart builds while it still runs),
    // then the last start again, which stops a start still building and what a run left going before it builds.
    vscode.commands.registerCommand('csharpShooter.restart', async () => {
      const last = state.lastStart;
      if (!last) return false;
      for (const session of [...state.sessions]) {
        const ended = new Promise((r) => { const d = vscode.debug.onDidTerminateDebugSession((s) => s.id === session.id && (d.dispose(), r())); });
        await vscode.debug.stopDebugging(session);
        await Promise.race([ended, new Promise((r) => setTimeout(r, 15000))]);
      }
      return vscode.debug.startDebugging(last.folder, last.config, { noDebug: !!last.config.noDebug });
    }));
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.addLaunchProfiles', async () => {
    const added = await addProfileEntries(await missingProfileEntries());
    vscode.window.showInformationMessage(added.length ? t('Added to Run and Debug: {0}', added.join(', ')) : t('Run and Debug has it already.'));
    return added;
  }));
  offerProfileEntries(context);
  context.subscriptions.push(
    // The list only: VS Code runs every provider's resolve methods for the type, so they are registered once (below), not here too
    // (a launch would be resolved, and built, twice).
    vscode.debug.registerDebugConfigurationProvider(TYPE, { provideDebugConfigurations: () => provider.provideDebugConfigurations() }, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    vscode.debug.registerDebugConfigurationProvider(TYPE, { resolveDebugConfiguration: provider.resolveDebugConfiguration.bind(provider), resolveDebugConfigurationWithSubstitutedVariables: provider.resolveDebugConfigurationWithSubstitutedVariables.bind(provider) }),
    vscode.debug.registerDebugAdapterTrackerFactory(TYPE, browserOpener(state)),
    // Solution Explorer → project → Debug: its profiles to pick from, as VS's start button's list.
    vscode.commands.registerCommand('csharpShooter.solution.debugProject', async (item, profileName) => {
      const profiles = runnableProfiles(item.file);
      const name = profileName ?? (profiles.length > 1 ? await vscode.window.showQuickPick(profiles.map((p) => p.name), { placeHolder: t('Launch profile') }) : profiles[0]?.name);
      if (profiles.length > 1 && !name) return false;
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(item.file));
      return vscode.debug.startDebugging(folder, configurationFor(item.file, name ?? null));
    }),
  );
  return { provider, state, running, onDidChangeRunning: state.changed.event, runnableProfiles, runnableProjects };
}

module.exports = { registerLaunch, readLaunchSettings, parseJsonc, runnableProfiles, runnableProjects, urlsOf };
