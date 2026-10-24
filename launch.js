// F5 as Visual Studio does it: each runnable project's launch profiles (Properties/launchSettings.json) are debug
// configurations; the project builds first, runs with the profile's environment and URLs, and the browser opens once the
// app listens. A launch.json entry can name them too: { "type": "csharpshooter", "request": "launch",
// "project": "${workspaceFolder}/WebApp/WebApp.csproj", "launchProfile": "WebApp Development" }.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

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
function msbuildProperties(project, configuration) {
  return new Promise((resolve, reject) => {
    execFile('dotnet', ['msbuild', project, '-getProperty:TargetPath', '-getProperty:RunCommand', `-p:Configuration=${configuration}`],
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

/** Builds the project in a task the person sees, as VS builds on F5; resolves with whether it succeeded. */
async function build(project, configuration) {
  // Before Build bindings of the project's gulpfiles (csharpShooter.taskRunner.buildBindings), as VS runs them.
  const { buildBindings } = require('./task-runner');
  if (!(await buildBindings('BeforeBuild', path.dirname(project)))) return false;
  const task = new vscode.Task({ type: 'shell', task: `build ${path.basename(project)}` }, vscode.TaskScope.Workspace,
    `build ${path.basename(project, '.csproj')}`, 'CSharpShooter',
    new vscode.ShellExecution('dotnet', ['build', project, '-c', configuration], { cwd: path.dirname(project) }), '$msCompile');
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  const execution = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const done = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== execution) return;
      done.dispose();
      resolve(e.exitCode === 0 && buildBindings('AfterBuild', path.dirname(project)));
    });
  });
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
    if (config.request !== 'launch' || !config.project) return config;
    const project = path.resolve(folder?.uri.fsPath || '', config.project);
    const configuration = config.configuration || 'Debug';
    if (config.build !== false) {
      const ok = await build(project, configuration);
      this.state.lastBuild = { project, ok };
      if (!ok) {
        vscode.window.showErrorMessage(`Build of ${path.basename(project)} failed; see the task's terminal and Problems.`);
        return undefined;
      }
    }
    const props = await msbuildProperties(project, configuration);
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
    return {
      ...config,
      program: config.program || props.TargetPath,
      cwd: config.cwd || (profile.workingDirectory ? path.resolve(path.dirname(project), profile.workingDirectory) : path.dirname(project)),
      args,
      env,
      // The browser, as VS opens it: once the app says it listens, at the profile's launchUrl.
      __browser: profile.launchBrowser && config.launchBrowser !== false ? { base: urls[0], path: profile.launchUrl || '', portBusy } : undefined,
    };
  }
}

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
      let opened = false;
      let polling;
      const open = (base) => {
        if (opened) return;
        opened = true;
        clearInterval(polling);
        const url = `${base.replace(/\/$/, '')}/${browser.path.replace(/^\//, '')}`;
        state.browserUrl = url;
        if (!process.env.CSHARPSHOOTER_NO_BROWSER) vscode.env.openExternal(vscode.Uri.parse(url));
      };
      const stop = () => clearInterval(polling);
      return {
        onWillStartSession() {
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

function registerLaunch(context) {
  const state = {};
  const provider = new LaunchProfiles(state);
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
  return { provider, state, runnableProfiles };
}

module.exports = { registerLaunch, readLaunchSettings, runnableProfiles, urlsOf };
