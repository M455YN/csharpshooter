// Startup project and active launch profile, as Visual Studio keeps them: the solution's startup project (read from VS's
// own .vs/<solution>/v*/.suo, then kept per workspace), and each project's active profile in its .csproj.user
// (<ActiveDebugProfile>, the file and element VS reads and writes, so a choice made here or there holds in both).
// F5 on the "Projekt startowy (CSharpShooter)" entry, the status bar and the Solution Explorer follow them.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const TYPE = 'csharpshooter';
const ENTRY_NAME = 'Projekt startowy (CSharpShooter)';
// VS's own Polish words for these (CommonIDE and ManagedProjectSystem resources).
const T = {
  startupMark: 'projekt startowy',
  setStartup: 'Ustaw jako projekt startowy',
  notRunnable: 'Projekt z typem wyjściowym biblioteki klasy nie może być bezpośrednio uruchomiony.',
  start: 'Rozpocznij',
  startNoDebug: 'Uruchom bez debugowania',
  profiles: 'Profile uruchamiania',
  framework: (tfm) => `Platforma (${tfm})`,
  debugProperties: (project) => `Właściwości debugowania ${project}`,
  pickProject: 'Projekt startowy',
  noProfile: 'Brak skonfigurowanych aktywnych profilów uruchamiania dla tego projektu.',
};

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
  const projectItem = vscode.window.createStatusBarItem('csharpShooter.startupProject', vscode.StatusBarAlignment.Left, 50);
  projectItem.name = T.pickProject;
  projectItem.command = 'csharpShooter.startup.pickProject';
  const startItem = vscode.window.createStatusBarItem('csharpShooter.startupProfile', vscode.StatusBarAlignment.Left, 49);
  startItem.name = T.start;
  startItem.command = 'csharpShooter.startup.menu';
  context.subscriptions.push(projectItem, startItem);
  const status = { project: '', start: '' };
  const update = async () => {
    const now = await startup.current();
    if (!now) {
      projectItem.hide();
      startItem.hide();
      return;
    }
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

module.exports = { registerStartup, startupEntry, ENTRY_NAME, readUserProperty, writeUserProperty, startupFromSuo };
