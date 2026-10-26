// Startup project and active launch profile, as Visual Studio keeps them: the solution's startup project (read from VS's
// own .vs/<solution>/v*/.suo, then kept per workspace), and each project's active profile in its .csproj.user
// (<ActiveDebugProfile>, the file and element VS reads and writes, so a choice made here or there holds in both).
// F5 on the "Projekt startowy (CSharpShooter)" entry, the status bar and the Solution Explorer follow them.
const vscode = require('vscode');
const { table } = require('./l10n');
const path = require('path');
const fs = require('fs');

const TYPE = 'csharpshooter';
const ENTRY_NAME = 'Projekt startowy (CSharpShooter)';
// VS's own words for these (CommonIDE and ManagedProjectSystem resources), in English and Polish (l10n/pl.json).
const T = table({
  startupMark: 'startup project',
  setStartup: 'Set as Startup Project',
  notRunnable: 'A project with an output type of Class Library cannot be started directly.',
  start: 'Start',
  startNoDebug: 'Start Without Debugging',
  profiles: 'Launch Profiles',
  framework: 'Framework ({0})',
  debugProperties: '{0} Debug Properties',
  pickProject: 'Startup Project',
  noProfile: 'There are no active launch profiles configured for this project.',
  configurations: 'Solution Configurations',
  platforms: 'Solution Platforms',
  restart: 'Restart',
  saveAll: 'Save All',
});

const projectName = (file) => path.basename(file, path.extname(file));
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The project VS has as startup in its .suo: the GUID after "StartupProject=" (UTF-16 in the binary), matched to the
 *  .sln's project of that GUID. Null when there is no .suo, no such entry or no .sln line for it (an .slnx has no GUIDs). */
function startupFromSuo(solution) {
  const name = path.basename(solution, path.extname(solution));
  const vsDir = path.join(path.dirname(solution), '.vs', name);
  let suo;
  try {
    suo = fs.readdirSync(vsDir).filter((d) => /^v\d+$/.test(d)).sort((a, b) => +b.slice(1) - +a.slice(1))
      .map((d) => path.join(vsDir, d, '.suo')).find((f) => fs.existsSync(f));
  } catch {
    return null;
  }
  if (!suo) return null;
  const data = fs.readFileSync(suo);
  const at = data.indexOf(Buffer.from('StartupProject=', 'utf16le'));
  if (at < 0) return null;
  const text = data.subarray(at, at + 200).toString('latin1').replace(/\0/g, '');
  const guid = /\{([0-9A-Fa-f-]{36})\}/.exec(text)?.[1];
  if (!guid) return null;
  const sln = fs.readFileSync(solution, 'utf8');
  const line = new RegExp(`Project\\("\\{[^}]+\\}"\\)\\s*=\\s*"[^"]+",\\s*"([^"]+)",\\s*"\\{${guid}\\}"`, 'i').exec(sln);
  return line ? { project: path.resolve(path.dirname(solution), line[1].replace(/\\/g, path.sep)), suo, mtime: fs.statSync(suo).mtimeMs } : null;
}

/** <Name> of a project's .csproj.user, or undefined. */
function readUserProperty(project, name) {
  const file = `${project}.user`;
  if (!fs.existsSync(file)) return undefined;
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(fs.readFileSync(file, 'utf8'))?.[1];
}

/** Sets <Name> in a project's .csproj.user as VS writes it: the value replaced in place, else a PropertyGroup of its own
 *  before </Project>, else a new file like VS's; its BOM, line endings and everything else kept. */
function writeUserProperty(project, name, value) {
  const file = `${project}.user`;
  const element = new RegExp(`(<${name}>)[^<]*(</${name}>)`);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = element.test(text) ? text.replace(element, `$1${value}$2`)
      : text.replace(/<\/Project>/, `  <PropertyGroup>${eol}    <${name}>${value}</${name}>${eol}  </PropertyGroup>${eol}</Project>`);
    if (next !== text) fs.writeFileSync(file, next);
    return;
  }
  const eol = process.platform === 'win32' ? '\r\n' : '\n';
  fs.writeFileSync(file, ['\uFEFF<?xml version="1.0" encoding="utf-8"?>',
    '<Project ToolsVersion="Current" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>', `    <${name}>${value}</${name}>`, '  </PropertyGroup>', '</Project>', ''].join(eol));
}

/** The solution's configurations and platforms, as its Configuration Manager lists them: the .sln's
 *  SolutionConfigurationPlatforms ("Debug|Any CPU = Debug|Any CPU"), an .slnx's <BuildType>/<Platform>, else VS's defaults. */
function solutionConfigurations(solution) {
  const text = solution && fs.existsSync(solution) ? fs.readFileSync(solution, 'utf8') : '';
  let pairs = [...(/GlobalSection\(SolutionConfigurationPlatforms\)[\s\S]*?EndGlobalSection/.exec(text)?.[0] || '').matchAll(/^\s*([^|=\r\n]+)\|([^=\r\n]+?)\s*=/gm)]
    .map(([, c, p]) => [c.trim(), p.trim()]);
  if (!pairs.length && /\.slnx$/i.test(solution || '')) {
    const names = (tag) => [...text.matchAll(new RegExp(`<${tag} Name="([^"]+)"`, 'g'))].map((m) => m[1]);
    const cs = names('BuildType');
    const ps = names('Platform');
    pairs = (cs.length ? cs : ['Debug', 'Release']).flatMap((c) => (ps.length ? ps : ['Any CPU']).map((p) => [c, p]));
  }
  if (!pairs.length) pairs = [['Debug', 'Any CPU'], ['Release', 'Any CPU']];
  return { configurations: [...new Set(pairs.map((p) => p[0]))], platforms: [...new Set(pairs.map((p) => p[1]))] };
}

/** What a solution configuration builds a project as, as VS maps it (a solution's "debug app" can build a project as
 *  Debug): an .sln's "{guid}.<cfg>|<platform>.ActiveCfg = Debug|Any CPU", an .slnx's <BuildType Solution="<cfg>|<platform>"
 *  Project="Debug" /> and <Platform .../> under the project (its platform may be *); the solution's own names where
 *  there is none. */
function projectConfiguration(solution, project, configuration, platform) {
  const rel = path.relative(path.dirname(solution || ''), project).toLowerCase();
  if (solution && /\.slnx$/i.test(solution) && fs.existsSync(solution)) {
    const text = fs.readFileSync(solution, 'utf8');
    const block = [...text.matchAll(/<Project\s+Path="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/Project>)/g)]
      .find(([, p]) => p.replace(/[\\/]/g, path.sep).toLowerCase() === rel)?.[2] || '';
    const pick = (tag, fallback) => {
      for (const [, sol, proj] of block.matchAll(new RegExp(`<${tag}\\s+Solution="([^"]+)"\\s+Project="([^"]+)"`, 'g'))) {
        const [c, p = '*'] = sol.split('|');
        if ((c === '*' || c.toLowerCase() === configuration.toLowerCase()) && (p === '*' || p.toLowerCase() === (platform || '').toLowerCase())) return proj;
      }
      return fallback;
    };
    return { configuration: pick('BuildType', configuration), platform: pick('Platform', platform) };
  }
  const text = solution && /\.sln$/i.test(solution) && fs.existsSync(solution) ? fs.readFileSync(solution, 'utf8') : '';
  const guid = [...text.matchAll(/Project\("\{[^}]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+)",\s*"\{([^}]+)\}"/g)]
    .find(([, p]) => p.replace(/\\/g, path.sep).toLowerCase() === rel)?.[2];
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mapped = guid && new RegExp(`\\{${guid}\\}\\.${esc(configuration)}\\|${esc(platform)}\\.ActiveCfg\\s*=\\s*([^|\\r\\n]+)\\|([^\\r\\n]+)`, 'i').exec(text);
  return mapped ? { configuration: mapped[1].trim(), platform: mapped[2].trim() } : { configuration, platform };
}

/** dotnet's arguments for a configuration and platform: -c, and the platform when it is not MSBuild's default (Any CPU). */
function buildArgs({ configuration, platform }) {
  return ['-c', configuration, ...(platform && !/^any\s?cpu$/i.test(platform) ? [`-p:Platform=${platform}`] : [])];
}

function frameworksOf(project) {
  const text = fs.readFileSync(project, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return (/<TargetFrameworks?>([^<]+)</.exec(text)?.[1] || '').split(';').map((f) => f.trim()).filter(Boolean);
}

class Startup {
  constructor(context, findSolution, launch) {
    this.context = context;
    this.findSolution = findSolution;
    this.launch = launch; // runnableProjects, runnableProfiles
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
  }

  async runnable() {
    return this.launch.runnableProjects();
  }

  isRunnable(project, runnable) {
    return runnable.some((p) => same(p, project));
  }

  /** The startup project: VS's .suo when it changed since last read (so VS's choice carries over), else this workspace's
   *  own, else the first runnable project, a web one first. */
  async project() {
    const runnable = await this.runnable();
    const solution = await this.findSolution();
    const stored = this.context.workspaceState.get('csharpShooter.startup');
    const fromSuo = solution && startupFromSuo(solution);
    if (fromSuo && this.isRunnable(fromSuo.project, runnable) && (!stored || (stored.suoMtime || 0) < fromSuo.mtime)) {
      await this.context.workspaceState.update('csharpShooter.startup', { project: fromSuo.project, suoMtime: fromSuo.mtime });
      if (!same(stored?.project, fromSuo.project)) this.changed.fire(); // the Solution Explorer's mark follows too
      return fromSuo.project;
    }
    if (stored && this.isRunnable(stored.project, runnable)) return stored.project;
    const web = runnable.find((p) => /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(fs.readFileSync(p, 'utf8')));
    return web || runnable[0];
  }

  async setProject(project) {
    if (!this.isRunnable(project, await this.runnable())) {
      vscode.window.showErrorMessage(T.notRunnable);
      return false;
    }
    const suoMtime = this.context.workspaceState.get('csharpShooter.startup')?.suoMtime;
    await this.context.workspaceState.update('csharpShooter.startup', { project: path.resolve(project), suoMtime: Math.max(suoMtime || 0, Date.now()) });
    this.changed.fire();
    return true;
  }

  /** A project's active profile: its .csproj.user's ActiveDebugProfile when that profile runs here, else its first. */
  profile(project) {
    const profiles = this.launch.runnableProfiles(project).map((p) => p.name);
    const active = readUserProperty(project, 'ActiveDebugProfile');
    return profiles.includes(active) ? active : profiles[0];
  }

  setProfile(project, name) {
    writeUserProperty(project, 'ActiveDebugProfile', name);
    this.changed.fire();
  }

  /** A multi-targeted project's active framework (ActiveDebugFramework), else none: one framework needs no choosing. */
  framework(project) {
    const all = frameworksOf(project);
    if (all.length < 2) return undefined;
    const active = readUserProperty(project, 'ActiveDebugFramework');
    return all.includes(active) ? active : all[0];
  }

  setFramework(project, tfm) {
    writeUserProperty(project, 'ActiveDebugFramework', tfm);
    this.changed.fire();
  }

  /** The solution's configuration and platform, as VS's toolbar has them (kept per workspace): Debug and the first
   *  platform until one is chosen. */
  async solutionSettings() {
    const solution = await this.findSolution();
    const { configurations, platforms } = solutionConfigurations(solution);
    const stored = this.context.workspaceState.get('csharpShooter.configuration') || {};
    return {
      solution, configurations, platforms,
      configuration: configurations.includes(stored.configuration) ? stored.configuration : configurations.find((c) => c === 'Debug') || configurations[0],
      platform: platforms.includes(stored.platform) ? stored.platform : platforms[0],
    };
  }

  async setSolutionSettings(change) {
    const stored = this.context.workspaceState.get('csharpShooter.configuration') || {};
    await this.context.workspaceState.update('csharpShooter.configuration', { ...stored, ...change });
    this.changed.fire();
  }

  /** What a build of the solution, or of one of its projects, is given: the solution's choice, mapped for a project. */
  async buildSettings(target) {
    const { solution, configuration, platform } = await this.solutionSettings();
    return /\.slnx?$/i.test(target) ? { configuration, platform } : projectConfiguration(solution, target, configuration, platform);
  }

  /** What F5 on the startup entry runs now. */
  async current() {
    const project = await this.project();
    if (!project) return undefined;
    return { project, profile: this.profile(project), framework: this.framework(project) };
  }
}

/** The launch.json entry that always runs the startup project with its active profile: selected once in Run and Debug,
 *  F5 and Ctrl+F5 then do what they do in VS. */
function startupEntry() {
  return { name: ENTRY_NAME, type: TYPE, request: 'launch', startupProject: true };
}

function registerStartup(context, findSolution, launch) {
  const startup = new Startup(context, findSolution, launch);
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // The status bar, as VS's toolbar: the startup project (click: choose another), and the start button with the active
  // profile's name (click: its menu of start, start without debugging, profiles, framework, debug properties).
  const projectItem = vscode.window.createStatusBarItem('csharpShooter.startupProject', vscode.StatusBarAlignment.Left, 56);
  projectItem.name = T.pickProject;
  projectItem.command = 'csharpShooter.startup.pickProject';
  const startItem = vscode.window.createStatusBarItem('csharpShooter.startupProfile', vscode.StatusBarAlignment.Left, 55);
  startItem.name = T.start;
  startItem.command = 'csharpShooter.startup.menu';
  context.subscriptions.push(projectItem, startItem);
  const status = { project: '', start: '', configuration: '', platform: '', restart: false };
  // Around them, as on VS's standard toolbar: Zapisz wszystko, the solution's configuration and platform, then Uruchom bez
  // debugowania and Uruchom ponownie (grey while nothing is being debugged, as VS greys it).
  const item = (id, priority, name, command, text, tooltip) => {
    const it = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Left, priority);
    Object.assign(it, { name, command, text, tooltip });
    context.subscriptions.push(it);
    return it;
  };
  const saveAllItem = item('csharpShooter.saveAll', 59, T.saveAll, 'workbench.action.files.saveAll', '$(save-all)', `${T.saveAll} (Ctrl+K S)`);
  const configurationItem = item('csharpShooter.configuration', 58, T.configurations, 'csharpShooter.startup.pickConfiguration', '', T.configurations);
  const platformItem = item('csharpShooter.platform', 57, T.platforms, 'csharpShooter.startup.pickPlatform', '', T.platforms);
  const noDebugItem = item('csharpShooter.startWithoutDebugging', 54, T.startNoDebug, 'csharpShooter.startup.startWithoutDebugging', '$(run)', `${T.startNoDebug} (Ctrl+F5)`);
  const restartItem = item('csharpShooter.restart', 53, T.restart, undefined, '$(debug-restart)', `${T.restart} (Ctrl+Shift+F5)`);
  // Live while there is something to restart: an app under the debugger, a start still building, a run without it.
  const debugging = () => {
    status.restart = launch.running();
    restartItem.command = status.restart ? 'csharpShooter.restart' : undefined;
    restartItem.color = status.restart ? undefined : new vscode.ThemeColor('disabledForeground');
  };
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(debugging), vscode.debug.onDidTerminateDebugSession(debugging),
    vscode.debug.onDidChangeActiveDebugSession(debugging), launch.onDidChangeRunning(debugging));
  debugging();
  const update = async () => {
    const now = await startup.current();
    const settings = await startup.solutionSettings();
    status.configuration = settings.configuration;
    status.platform = settings.platform;
    configurationItem.text = `${settings.configuration} $(chevron-down)`;
    platformItem.text = `${settings.platform} $(chevron-down)`;
    for (const it of [saveAllItem, configurationItem, platformItem]) it.show();
    if (!now) {
      for (const it of [projectItem, startItem, noDebugItem, restartItem]) it.hide();
      return;
    }
    noDebugItem.show();
    restartItem.show();
    status.project = projectItem.text = `$(project) ${projectName(now.project)}`;
    projectItem.tooltip = `${T.pickProject}: ${now.project}`;
    status.start = startItem.text = `$(debug-start) ${now.profile ?? projectName(now.project)}${now.framework ? ` (${now.framework})` : ''}`;
    startItem.tooltip = `${T.start} (F5): ${projectName(now.project)} / ${now.profile ?? '—'}`;
    projectItem.show();
    startItem.show();
  };
  startup.onDidChange(update);
  const userFiles = vscode.workspace.createFileSystemWatcher('**/*.{csproj.user,suo}');
  for (const ev of [userFiles.onDidChange, userFiles.onDidCreate]) ev(() => update());
  context.subscriptions.push(userFiles);
  update();

  const folderOf = (project) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project)) || vscode.workspace.workspaceFolders?.[0];
  const start = async (noDebug) => {
    const now = await startup.current();
    if (!now) return false;
    return vscode.debug.startDebugging(folderOf(now.project), startupEntry(), { noDebug });
  };

  register('csharpShooter.startup.setProject', async (item) => startup.setProject(item.file ?? item));
  register('csharpShooter.startup.pickProject', async () => {
    const current = await startup.project();
    const picked = await vscode.window.showQuickPick((await startup.runnable()).map((p) => ({
      label: `${same(p, current) ? '$(check) ' : ''}${projectName(p)}`, description: vscode.workspace.asRelativePath(p), project: p,
    })), { placeHolder: T.pickProject });
    if (picked) await startup.setProject(picked.project);
  });
  const pickSetting = async (key, list, title) => {
    const settings = await startup.solutionSettings();
    const picked = await vscode.window.showQuickPick(settings[list].map((v) => ({ label: `${v === settings[key] ? '$(check) ' : '$(blank) '}${v}`, value: v })), { placeHolder: title });
    if (picked) await startup.setSolutionSettings({ [key]: picked.value });
  };
  // `value` (the tests'): set without asking.
  register('csharpShooter.startup.pickConfiguration', (value) => (typeof value === 'string' ? startup.setSolutionSettings({ configuration: value }) : pickSetting('configuration', 'configurations', T.configurations)));
  register('csharpShooter.startup.pickPlatform', (value) => (typeof value === 'string' ? startup.setSolutionSettings({ platform: value }) : pickSetting('platform', 'platforms', T.platforms)));
  register('csharpShooter.startup.selectProfile', async (project, name) => startup.setProfile(project, name));
  register('csharpShooter.startup.start', () => start(false));
  register('csharpShooter.startup.startWithoutDebugging', () => start(true));
  register('csharpShooter.startup.menu', async () => {
    const now = await startup.current();
    if (!now) return;
    const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items = [
      { label: `$(debug-start) ${T.start}`, description: 'F5', run: () => start(false) },
      { label: `$(run) ${T.startNoDebug}`, description: 'Ctrl+F5', run: () => start(true) },
      sep(T.profiles),
      ...launch.runnableProfiles(now.project).map((p) => ({
        label: `${p.name === now.profile ? '$(check) ' : '$(blank) '}${p.name}`, description: p.profile.commandName === 'IISExpress' ? 'IIS Express → Kestrel' : '',
        run: () => startup.setProfile(now.project, p.name),
      })),
      ...(frameworksOf(now.project).length > 1 ? [sep(T.framework(now.framework)), ...frameworksOf(now.project).map((tfm) => ({
        label: `${tfm === now.framework ? '$(check) ' : '$(blank) '}${tfm}`, run: () => startup.setFramework(now.project, tfm),
      }))] : []),
      sep(''),
      { label: `$(settings) ${T.debugProperties(projectName(now.project))}`, run: () => {
        const file = path.join(path.dirname(now.project), 'Properties', 'launchSettings.json');
        return fs.existsSync(file) ? vscode.window.showTextDocument(vscode.Uri.file(file)) : vscode.window.showWarningMessage(T.noProfile);
      } },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${projectName(now.project)}: ${now.profile ?? '—'}` });
    await picked?.run();
  });
  return { startup, status, entryName: ENTRY_NAME, startupEntry, readUserProperty, startupFromSuo };
}

module.exports = { registerStartup, startupEntry, ENTRY_NAME, readUserProperty, writeUserProperty, startupFromSuo, solutionConfigurations, projectConfiguration, buildArgs };
