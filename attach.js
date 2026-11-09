// Attach to Process (Ctrl+Alt+P) and Reattach to Process (Shift+Alt+P), as Visual Studio 2026 has them (its words, and its
// columns Proces, Identyfikator PID, Tytuł, Nazwa użytkownika, Sesja, Wiersz polecenia), over Passenger's list: the .NET
// programs this machine runs, found by their runtime's diagnostic port, those attached to before first.
const vscode = require('vscode');
const fs = require('fs');
const { execFile } = require('child_process');
const { t } = require('./l10n');

const TYPE = 'csharpshooter';
const RECENT = 'csharpShooter.attachedTo';

/** What a program is to a person (Passenger's DotnetProcess.Program): the .dll `dotnet` runs, else the executable's name. */
function programName(name, commandLine) {
  const exe = name.replace(/\.exe$/i, '');
  if (exe.toLowerCase() !== 'dotnet') return exe;
  const dll = (commandLine || '').match(/"[^"]*\.dll"|[^\s"]+\.dll/i)?.[0];
  return dll ? dll.replace(/"/g, '').replace(/^.*[\\/]/, '').replace(/\.dll$/i, '') : exe;
}

const same = (a, b) => a.name === b.name && a.commandLine === b.commandLine;

/** Reattach's choice, as Passenger's: the process last attached to while it runs, else those under its name and command
 *  line, else those under its name. */
function reattachCandidates(running, last) {
  const one = running.find((p) => p.id === last.id && same(p, last));
  if (one) return [one];
  const alike = running.filter((p) => same(p, last));
  return alike.length ? alike : running.filter((p) => p.name === last.name);
}

/** The .NET programs a debugger can attach to: CoreCLR's, each with its diagnostic port's pipe (dotnet-diagnostic-<pid>),
 *  as Windows describes them (name, command line, user, session, window title). */
async function listProcesses() {
  // shortcut: Windows only (the .vsix is win32-x64); macOS/Linux would read clr-debug-pipe-<pid>-*-in in the temp folder.
  let pipes;
  try { pipes = fs.readdirSync('\\\\.\\pipe\\'); } catch { return []; }
  const ids = [...new Set(pipes.map((p) => /^dotnet-diagnostic-(\d+)/.exec(p)?.[1]).filter(Boolean))];
  if (!ids.length) return [];
  const script = `$ids = @(${ids.join(',')})
$t = @{}; Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { $t[$_.Id] = $_.MainWindowTitle }
$f = ($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR '
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter $f | ForEach-Object {
  $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
  [pscustomobject]@{ id = [int]$_.ProcessId; name = $_.Name; commandLine = "$($_.CommandLine)"; session = $_.SessionId
    user = $(if ($o.User) { "$($o.Domain)\\$($o.User)" } else { '' }); title = "$($t[[int]$_.ProcessId])" } })`;
  const out = await new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 16 << 20 }, (e, stdout) => resolve(stdout || '')));
  let found;
  try { found = JSON.parse(out.trim() || '[]'); } catch { return []; }
  return found.map((p) => ({ ...p, program: programName(p.name, p.commandLine) }))
    .sort((a, b) => a.program.localeCompare(b.program, undefined, { sensitivity: 'base' }) || a.id - b.id);
}

/** The dialog as a quick pick: the programs filtered as typed (by name, PID, title, user or command line), Refresh to list
 *  them again; the one chosen, or undefined. */
function pick(context, { search = '', title = t('Attach to Process') } = {}) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    const refresh = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: t('Refresh') };
    Object.assign(qp, { title, value: search, placeholder: t('Filter processes'), matchOnDescription: true, matchOnDetail: true, buttons: [refresh] });
    const item = (p) => ({
      label: p.program,
      description: [`${t('PID')} ${p.id}`, p.title].filter(Boolean).join('  ·  '),
      detail: [p.user, `${t('Session')} ${p.session}`, p.commandLine].filter(Boolean).join('  ·  '),
      process: p,
    });
    const fill = async () => {
      qp.busy = true;
      const kept = qp.activeItems[0]?.process?.id;
      const running = await listProcesses();
      const recent = context.workspaceState.get(RECENT, []);
      const before = running.filter((p) => recent.some((r) => same(r, p)));
      const others = running.filter((p) => !before.includes(p));
      const separator = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
      qp.items = before.length
        ? [separator(t('Recently attached')), ...before.map(item), ...(others.length ? [separator(t('Other processes'))] : []), ...others.map(item)]
        : others.map(item);
      const again = qp.items.find((i) => i.process?.id === kept);
      if (again) qp.activeItems = [again];
      if (!running.length) qp.placeholder = t('No running processes were found.');
      qp.busy = false;
    };
    qp.onDidTriggerButton((b) => b === refresh && fill());
    qp.onDidAccept(() => { const chosen = qp.selectedItems[0]?.process; if (chosen) { resolve(chosen); qp.hide(); } });
    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    qp.show();
    fill();
  });
}

async function attach(context, p) {
  const recent = context.workspaceState.get(RECENT, []).filter((r) => !same(r, p));
  await context.workspaceState.update(RECENT, [...recent, { id: p.id, name: p.name, commandLine: p.commandLine, program: p.program }].slice(-10));
  return vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0],
    { type: TYPE, request: 'attach', name: `${p.program} (${p.id})`, processId: p.id });
}

function registerAttach(context) {
  const attachToProcess = async (options) => {
    const chosen = await pick(context, options);
    return chosen ? attach(context, chosen) : false;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('csharpShooter.attachToProcess', () => attachToProcess()),
    // Reattach as VS: the last program attached to at once when one matches, else the dialog, searched for it.
    vscode.commands.registerCommand('csharpShooter.reattachToProcess', async () => {
      const last = context.workspaceState.get(RECENT, []).at(-1);
      if (!last) return attachToProcess();
      const finding = listProcesses();
      vscode.window.setStatusBarMessage(t('Reattaching to {0}...', last.program), finding);
      const candidates = reattachCandidates(await finding, last);
      if (candidates.length === 1) return attach(context, candidates[0]);
      if (!candidates.length) vscode.window.showWarningMessage(t('Unable to find matching process. Select the process to attach to from the list.'));
      return attachToProcess({ search: last.program, title: t('Reattach to Process') });
    }),
    // launch.json's "processId": "${command:csharpShooter.pickProcess}": the PID chosen, or a cancelled start.
    vscode.commands.registerCommand('csharpShooter.pickProcess', async () => (await pick(context))?.id.toString()),
  );
}

module.exports = { registerAttach, listProcesses, programName, reattachCandidates };
