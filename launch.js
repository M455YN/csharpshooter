// F5 as Visual Studio does it: each runnable project's launch profiles (Properties/launchSettings.json) are debug
// configurations; the project builds first, runs with the profile's environment and URLs, and the browser opens once the
// app listens. A launch.json entry can name them too: { "type": "csharpshooter", "request": "launch",
// "project": "${workspaceFolder}/WebApp/WebApp.csproj", "launchProfile": "WebApp Development" }.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { launchProgress, buildLog, followBuildLog } = require('./build-progress');

const TYPE = 'csharpshooter';

/** launchSettings.json as JSON, which allows comments and trailing commas as VS writes and reads it. */
function readLaunchSettings(project) {
  const file = path.join(path.dirname(project), 'Properties', 'launchSettings.json');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

/** Profiles that run the project: Project as Kestrel, IISExpress also as Kestrel on the IIS Express URLs, since IIS
 *  Express runs only under Visual Studio. Executable, Docker and the rest are not this debugger's. */
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
function msbuildProperties(project, configuration, framework) {
  return new Promise((resolve, reject) => {
    execFile('dotnet', ['msbuild', project, '-getProperty:TargetPath', '-getProperty:RunCommand', `-p:Configuration=${configuration}`,
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

/** Builds the project in a task the person sees, as VS builds on F5, saying in `progress` what the build is doing;
 *  resolves with whether it succeeded, and the errors it had. */
async function build(project, configuration, framework, progress) {
  // Before Build bindings of the project's gulpfiles (csharpShooter.taskRunner.buildBindings), as VS runs them.
  const { buildBindings } = require('./task-runner');
  progress.report('Kompilacja rozpoczęta…');
  if (!(await buildBindings('BeforeBuild', path.dirname(project)))) return { ok: false, errors: 0 };
  const log = buildLog();
  const task = new vscode.Task({ type: 'shell', task: `build ${path.basename(project)}` }, vscode.TaskScope.Workspace,
    `build ${path.basename(project, '.csproj')}`, 'CSharpShooter',
    new vscode.ShellExecution('dotnet', ['build', project, '-c', configuration, ...(framework ? ['-f', framework] : []), { value: log.arg, quoting: vscode.ShellQuoting.Strong }], { cwd: path.dirname(project) }), '$msCompile');
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
  if (ok) progress.report(`Kompilacja zakończyła się powodzeniem${following.counts.warnings ? ` (ostrzeżenia: ${following.counts.warnings})` : ''}`);
  return { ok, errors: following.counts.errors };
}

/** Runnable projects of the solution: Exe output or a web SDK, which is what has launch profiles to run. */
async function runnableProjects() {
  const files = await vscode.workspace.findFiles('**/*.csproj', '**/{node_modules,bin,obj}/**');
  return files.map((u) => u.fsPath).filter((p) => {
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
      : (await vscode.window.showQuickPick(projects.map((p) => ({ label: path.basename(p, '.csproj'), project: p })), { placeHolder: 'Project to run' }))?.project;
    if (!project) return undefined;
    const profiles = runnableProfiles(project);
    const picked = profiles.length > 1
      ? (await vscode.window.showQuickPick(profiles.map((p) => p.name), { placeHolder: 'Launch profile' }))
      : profiles[0]?.name;
    if (profiles.length > 1 && !picked) return undefined;
    return configurationFor(project, picked ?? null);
  }

  /** A configuration that names a project: built, its program found, its profile's environment and URLs applied. */
  async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    // "Projekt startowy (CSharpShooter)": the startup project with its active profile and framework, as VS's F5 runs it.
    if (config.request === 'launch' && config.startupProject && this.startup) {
      const now = await this.startup.current();
      if (!now) {
        vscode.window.showErrorMessage('No runnable project in this workspace.');
        return undefined;
      }
      config = { ...config, project: now.project, launchProfile: now.profile ?? null, framework: config.framework ?? now.framework,
        name: `${path.basename(now.project, '.csproj')}: ${now.profile ?? path.basename(now.project, '.csproj')}` };
    }
    if (config.request !== 'launch' || !config.project) return config;
    const project = path.resolve(folder?.uri.fsPath || '', config.project);
    // What it is doing, at the bottom right, until the browser opens (or the start is done when there is none to wait for).
    const progress = launchProgress(config.name || path.basename(project, '.csproj'));
    this.state.lastProgress = progress;
    let handedOver = false;
    try {
      return await this.launch(folder, config, project, progress, () => (handedOver = true));
    } finally {
      if (!handedOver) progress.done();
    }
  }

  async launch(folder, config, project, progress, handOver) {
    const configuration = config.configuration || 'Debug';
    if (config.build !== false) {
      const built = await build(project, configuration, config.framework, progress);
      this.state.lastBuild = { project, ok: built.ok };
      if (!built.ok) {
        if (!progress.token.isCancellationRequested) {
          vscode.window.showErrorMessage(`Build of ${path.basename(project)} failed${built.errors ? ` (${built.errors} errors)` : ''}; see the task's terminal and Problems.`);
        }
        return undefined;
      }
    }
    progress.report('Odczytywanie właściwości projektu…');
    const props = await msbuildProperties(project, configuration, config.framework);
    const entry = config.launchProfile ? runnableProfiles(project).find((p) => p.name === config.launchProfile) : undefined;
    if (config.launchProfile && !entry) {
      vscode.window.showErrorMessage(`No launch profile "${config.launchProfile}" in ${path.basename(project)} that runs here.`);
      return undefined;
    }
    const profile = entry?.profile || {};
    const urls = entry ? urlsOf(entry) : [];
    const env = { ...(profile.environmentVariables || {}), ...(config.env || {}) };
    if (urls.length && !env.ASPNETCORE_URLS) env.ASPNETCORE_URLS = urls.join(';');
    const args = config.args ?? (profile.commandLineArgs ? profile.commandLineArgs.split(' ').filter(Boolean) : []);
    // Another process on the profile's port (an earlier run left going) keeps the app from listening there, and would
    // pass for it to the browser's wait below.
    const portBusy = urls[0] && (await accepts(urls[0]));
    if (portBusy) vscode.window.showWarningMessage(`${urls[0]} is already in use by another process; ${path.basename(project, '.csproj')} may not start there.`);
    const resolved = {
      ...config,
      program: config.program || props.TargetPath,
      cwd: config.cwd || (profile.workingDirectory ? path.resolve(path.dirname(project), profile.workingDirectory) : path.dirname(project)),
      args,
      env,
      // The browser, as VS opens it: once the app says it listens, at the profile's launchUrl.
      __browser: profile.launchBrowser && config.launchBrowser !== false ? { base: urls[0], path: profile.launchUrl || '', portBusy } : undefined,
    };
    // Ctrl+F5, as VS's Start Without Debugging: the program in a terminal of its own, no debugger, the browser as F5's.
    if (config.noDebug) {
      handOver();
      await runWithoutDebugging(resolved, this.state, progress);
      return undefined;
    }
    progress.report('Uruchamianie z debugerem…');
    // The debug session's tracker says the rest (the wait for the port, the browser) and closes it.
    if (resolved.__browser?.base && !portBusy) {
      handOver();
      const id = String((this.state.progressIds = (this.state.progressIds || 0) + 1));
      (this.state.progresses ||= new Map()).set(id, progress);
      resolved.__progress = id;
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
  progress.report('Uruchamianie bez debugowania…');
  const viaDotnet = /\.dll$/i.test(config.program);
  const exec = new vscode.ProcessExecution(viaDotnet ? 'dotnet' : config.program, [...(viaDotnet ? [config.program] : []), ...(config.args || [])],
    { cwd: config.cwd, env: config.env });
  const label = config.name || path.basename(config.program);
  const task = new vscode.Task({ type: 'process', task: label }, vscode.TaskScope.Workspace, label, 'CSharpShooter', exec);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  task.isBackground = true;
  const execution = await vscode.tasks.executeTask(task);
  state.lastRunWithoutDebugging = { name: label, execution };
  const browser = config.__browser;
  if (!browser?.base || browser.portBusy) return;
  progress.report(listeningMessage(browser.base));
  for (let i = 0; i < 300 && vscode.tasks.taskExecutions.includes(execution) && !progress.token.isCancellationRequested; i++) {
    if (await accepts(browser.base)) {
      const url = `${browser.base.replace(/\/$/, '')}/${browser.path.replace(/^\//, '')}`;
      progress.report('Otwieranie przeglądarki…');
      state.browserUrl = url;
      if (!process.env.CSHARPSHOOTER_NO_BROWSER) vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const listeningMessage = (url) => `Czekanie, aż aplikacja zacznie nasłuchiwać (${url})…`;

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
        progress?.report('Otwieranie przeglądarki…');
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

/** launch.json entries for the runnable projects' launch profiles that launch.json does not have yet, per folder.
 *  VS Code lists only launch.json's configurations in the Run and Debug dropdown (an extension's dynamic ones wait behind
 *  ".NET (CSharpShooter)..."), so this is how "WebApp: WebApp Development" gets there, as in VS's start button. */
async function missingProfileEntries() {
  const out = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const have = vscode.workspace.getConfiguration('launch', folder.uri).get('configurations') || [];
    if ((await runnableProjects()).length && !have.some((c) => c.type === TYPE && c.startupProject)) {
      out.push({ folder, entry: require('./startup').startupEntry() });
    }
    const known = new Set(have.filter((c) => c.type === TYPE && c.launchProfile).map((c) => `${String(c.project).replace(/\\/g, '/').toLowerCase()}|${c.launchProfile}`));
    for (const project of await runnableProjects()) {
      if (!project.toLowerCase().startsWith(folder.uri.fsPath.toLowerCase())) continue;
      const rel = `\${workspaceFolder}/${path.relative(folder.uri.fsPath, project).replace(/\\/g, '/')}`;
      for (const { name } of runnableProfiles(project)) {
        if (!known.has(`${rel.toLowerCase()}|${name}`)) out.push({ folder, entry: { ...configurationFor(rel, name), name: `${path.basename(project, '.csproj')}: ${name}` } });
      }
    }
  }
  return out;
}

/** Adds them to each folder's launch.json (through VS Code's settings, which edit the file in place). */
async function addProfileEntries(missing) {
  for (const folder of new Set(missing.map((m) => m.folder))) {
    const launch = vscode.workspace.getConfiguration('launch', folder.uri);
    const entries = missing.filter((m) => m.folder === folder).map((m) => m.entry);
    await launch.update('configurations', [...(launch.get('configurations') || []), ...entries], vscode.ConfigurationTarget.WorkspaceFolder);
  }
  return missing.map((m) => m.entry.name);
}

/** As a folder opens: asks once (csharpShooter.launchProfilesInLaunchJson: ask), adds silently (always) or leaves it (never). */
async function offerProfileEntries(context) {
  const mode = vscode.workspace.getConfiguration('csharpShooter').get('launchProfilesInLaunchJson');
  if (mode === 'never' || context.workspaceState.get('csharpShooter.launchProfilesDeclined')) return;
  const missing = await missingProfileEntries();
  if (!missing.length) return;
  if (mode !== 'always') {
    const names = missing.map((m) => m.entry.name);
    const answer = await vscode.window.showInformationMessage(
      `Add the launch profiles of launchSettings.json to Run and Debug (.vscode/launch.json)? ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`,
      'Add', 'Not now', 'Never');
    if (answer === 'Never') await context.workspaceState.update('csharpShooter.launchProfilesDeclined', true);
    if (answer !== 'Add') return;
  }
  await addProfileEntries(missing);
}

function registerLaunch(context) {
  const state = {};
  const provider = new LaunchProfiles(state);
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.addLaunchProfiles', async () => {
    const added = await addProfileEntries(await missingProfileEntries());
    vscode.window.showInformationMessage(added.length ? `Added to Run and Debug: ${added.join(', ')}` : 'Run and Debug has every launch profile already.');
    return added;
  }));
  offerProfileEntries(context);
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(TYPE, provider, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    vscode.debug.registerDebugConfigurationProvider(TYPE, { resolveDebugConfiguration: provider.resolveDebugConfiguration.bind(provider), resolveDebugConfigurationWithSubstitutedVariables: provider.resolveDebugConfigurationWithSubstitutedVariables.bind(provider) }),
    vscode.debug.registerDebugAdapterTrackerFactory(TYPE, browserOpener(state)),
    // Solution Explorer → project → Debug: its profiles to pick from, as VS's start button's list.
    vscode.commands.registerCommand('csharpShooter.solution.debugProject', async (item, profileName) => {
      const profiles = runnableProfiles(item.file);
      const name = profileName ?? (profiles.length > 1 ? await vscode.window.showQuickPick(profiles.map((p) => p.name), { placeHolder: 'Launch profile' }) : profiles[0]?.name);
      if (profiles.length > 1 && !name) return false;
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(item.file));
      return vscode.debug.startDebugging(folder, configurationFor(item.file, name ?? null));
    }),
  );
  return { provider, state, runnableProfiles, runnableProjects };
}

module.exports = { registerLaunch, readLaunchSettings, runnableProfiles, runnableProjects, urlsOf };
