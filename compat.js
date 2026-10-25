// F5 on configurations written for Microsoft's debuggers: "coreclr" (the C# extension's vsdbg) and "dotnet" (C# Dev Kit)
// run on CSharpShooter's debugger instead, when the extension that owns the type is not there to run them.
const vscode = require('vscode');
const { t } = require('./l10n');
const path = require('path');
const fs = require('fs');
const { runnableProfiles, urlsOf } = require('./launch');

const TYPE = 'csharpshooter';
const OWNERS = { coreclr: 'ms-dotnettools.csharp', dotnet: 'ms-dotnettools.csdevkit' };
// coreclr options this debugger has no counterpart for: named once in the output, then left out.
const UNSUPPORTED = ['sourceFileMap', 'symbolOptions', 'requireExactSource', 'sourceLinkOptions', 'logging', 'targetArchitecture',
  'suppressJITOptimizations', 'enableStepFiltering', 'checkForDevCert', 'expressionEvaluationOptions', 'targetOutputLogPath'];

function takesOver(type) {
  const mode = vscode.workspace.getConfiguration('csharpShooter').get('runMicrosoftConfigurations');
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return !vscode.extensions.getExtension(OWNERS[type]); // auto: the owner is not installed or is disabled
}

/** KEY=VALUE lines of an envFile, # comments and quotes as the C# extension reads them. */
function readEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** The launchSettings.json profile a coreclr launch applies, as the C# extension does: the one named in
 *  launchSettingsProfile, else the first "Project" profile of the project in cwd; none when launchSettingsProfile is null. */
function coreclrProfile(config) {
  if (config.launchSettingsProfile === null || !config.cwd) return undefined;
  const project = fs.existsSync(config.cwd) && fs.readdirSync(config.cwd).find((f) => f.endsWith('.csproj'));
  if (!project) return undefined;
  const profiles = runnableProfiles(path.join(config.cwd, project));
  return config.launchSettingsProfile
    ? profiles.find((p) => p.name === config.launchSettingsProfile)
    : profiles.find((p) => p.profile.commandName === 'Project');
}

function fromCoreclr(config, output) {
  if (config.pipeTransport) {
    vscode.window.showErrorMessage(t("\"{0}\" debugs over pipeTransport (a remote machine or container), which CSharpShooter's debugger does not do.", config.name));
    return undefined;
  }
  const ignored = UNSUPPORTED.filter((k) => k in config);
  if (ignored.length) output.appendLine(`"${config.name}": ${ignored.join(', ')} have no counterpart in CSharpShooter's debugger and are left out.`);
  const common = { type: TYPE, name: config.name, request: config.request, justMyCode: config.justMyCode, preLaunchTask: config.preLaunchTask, postDebugTask: config.postDebugTask };
  if (config.request === 'attach') return { ...common, processId: config.processId };

  const entry = coreclrProfile(config);
  const urls = entry ? urlsOf(entry) : [];
  const env = {
    ...(entry?.profile.environmentVariables || {}),
    ...(config.envFile && fs.existsSync(config.envFile) ? readEnvFile(config.envFile) : {}),
    ...(config.env || {}),
  };
  if (urls.length && !env.ASPNETCORE_URLS) env.ASPNETCORE_URLS = urls.join(';');
  // serverReadyAction opens the browser once the app listens: what the profile's launchBrowser does here.
  const browser = config.serverReadyAction && (config.serverReadyAction.action || 'openExternally') === 'openExternally'
    ? { base: urls[0], path: entry?.profile.launchUrl || '' } : undefined;
  return {
    ...common, program: config.program, args: config.args, cwd: config.cwd, env, stopAtEntry: config.stopAtEntry, console: config.console,
    ...(browser ? { __browser: browser } : {}),
  };
}

/** C# Dev Kit's { type: "dotnet", projectPath, launchConfigurationId: "TargetFramework=…;Profile" }: a project and its profile. */
function fromDotnet(config) {
  const profile = (config.launchConfigurationId || '').split(';').filter((p) => p && !p.includes('=')).pop();
  return { type: TYPE, request: 'launch', name: config.name, project: config.projectPath, launchProfile: profile || null, preLaunchTask: config.preLaunchTask };
}

/** A '*' provider sees every configuration F5 starts. First it hands the two Microsoft types to CSharpShooter's type,
 *  marked with where they came from; once ${workspaceFolder} and the rest are substituted (a coreclr cwd has to be a real
 *  folder to find its launchSettings.json), it converts them, a dotnet one through the launch profiles' own resolution. */
function registerCompat(context, output, launchProvider) {
  const told = new Set();
  const provider = {
    resolveDebugConfiguration(folder, config) {
      if (!(config.type in OWNERS) || !takesOver(config.type)) return config;
      if (!told.has(config.name)) {
        told.add(config.name);
        output.appendLine(`"${config.name}" (${config.type}) runs on CSharpShooter's debugger (csharpShooter.runMicrosoftConfigurations).`);
      }
      return { ...config, type: TYPE, __from: config.type };
    },
    async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
      if (config.type !== TYPE || !config.__from) return config;
      const from = config.__from;
      delete config.__from;
      // Fields left undefined are dropped, so the new type's defaults apply.
      const clean = (c) => c && JSON.parse(JSON.stringify(c));
      if (from === 'coreclr') return clean(fromCoreclr(config, output));
      // As a project and profile, through CSharpShooter's own F5 resolution: build, program, environment, browser.
      return launchProvider.resolveDebugConfigurationWithSubstitutedVariables(folder, clean(fromDotnet(config)));
    },
  };
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('*', provider));
}

module.exports = { registerCompat, fromCoreclr, fromDotnet };
