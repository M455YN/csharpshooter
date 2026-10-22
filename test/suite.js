// Checks run in the editor against the workspace's solution. Each check names a file, a place found by a needle on its
// line, and what has to come back. CHECKS_FILE (JSON) replaces the defaults, written for a sample ASP.NET Core MVC solution.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const defaultChecks = [
  { name: 'C#: F12 on a method (.cs)', file: 'Contoso.Core/Authorization/AppUser.cs', needle: 'RightsChecker.CheckRightsExpr(conditions, __GetModules', off: 20, kind: 'definition', expect: 'RightsChecker.cs' },
  { name: 'C#: completion after a dot (.cs)', file: 'Contoso.Core/Authorization/AppUser.cs', needle: 'RightsChecker.CheckRightsExpr(conditions, __GetModules', off: 14, kind: 'completion', expect: 'CheckRightsExpr' },
  { name: 'cshtml: completion of Model.', file: 'WebApp/Views/Pass/Login.cshtml', needle: '@if (Model.', off: 11, kind: 'completion', expect: 'ShowLogOutMessage' },
  { name: 'cshtml: F12 on @model type', file: 'WebApp/Views/Pass/Login.cshtml', needle: '@model LoginViewModel', off: 10, kind: 'definition', expect: 'LoginViewModel.cs' },
  { name: 'cshtml: F12 on Model.LogOutMessage', file: 'WebApp/Views/Pass/Login.cshtml', needle: '@Model.LogOutMessage', off: 10, kind: 'definition', expect: 'LoginViewModel.cs' },
  { name: 'cshtml: F12 on L.p (other project)', file: 'WebApp/Views/Pass/Login.cshtml', needle: '@L.p("Application', off: 3, kind: 'definition', expect: 'L.cs' },
  { name: 'tag helpers: asp-* in <input>', file: 'WebApp/Views/Pass/Login.cshtml', needle: '<input asp-for', off: 7, kind: 'completion', expect: 'asp-for' },
  { name: 'tag helpers: asp-* in <form>', file: 'WebApp/Views/Pass/Login.cshtml', needle: '<form ', off: 6, kind: 'completion', expect: 'asp-antiforgery' }, // this <form> already has asp-action
  { name: 'tag helpers: F12 on asp-for="Login"', file: 'WebApp/Views/Pass/Login.cshtml', needle: 'asp-for="Login', off: 10, kind: 'definition', expect: 'LoginViewModel.cs' },
  { name: 'tag helpers: hover on asp-action', file: 'WebApp/Views/Pass/Login.cshtml', needle: 'asp-action', off: 4, kind: 'hover', expect: 'FormTagHelper' },
];

const defaultDebug = {
  program: 'WebApp/bin/Debug/net10.0/WebApp.dll', cwd: 'WebApp',
  breakpoint: { file: 'WebApp/Program.cs', needle: 'CreateHostBuilder(args).Build().Run();' },
  evaluate: 'args.Length',
};

async function position(file, needle, off) {
  const doc = await vscode.workspace.openTextDocument(path.resolve(root(), file));
  const line = doc.getText().split(/\r?\n/).findIndex((l) => l.includes(needle));
  if (line < 0) throw new Error(`"${needle}" not in ${file}`);
  return { doc, pos: new vscode.Position(line, doc.lineAt(line).text.indexOf(needle) + off) };
}

async function ask(check) {
  const { doc, pos } = await position(check.file, check.needle, check.off);
  await vscode.window.showTextDocument(doc);
  if (check.kind === 'definition') {
    const found = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos)) || [];
    return found.map((l) => `${path.basename((l.targetUri || l.uri).fsPath)}:${(l.targetSelectionRange || l.targetRange || l.range).start.line + 1}`);
  }
  if (check.kind === 'completion') {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, pos);
    return (list?.items || []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  }
  const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos)) || [];
  return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)));
}

// The first answers after loading can be empty while Razor generates; asked again until they come or time runs out.
async function check(c, deadline) {
  let got = [];
  do {
    got = await ask(c);
    if (got.some((g) => g.includes(c.expect))) return { ok: true, got };
    await sleep(3000);
  } while (Date.now() < deadline);
  return { ok: false, got };
}

async function debugCheck(d) {
  const program = path.resolve(root(), d.program);
  if (!fs.existsSync(program)) return { ok: false, got: [`not built: ${program}`] };
  const { doc, pos } = await position(d.breakpoint.file, d.breakpoint.needle, 0);
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(doc.uri, pos))]);
  let stopped, printed;
  const stoppedEvent = new Promise((r) => (stopped = r));
  const printedEvent = new Promise((r) => (printed = r));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('csharpshooter', {
    // This test's session only: one an earlier check stopped may still be ending.
    createDebugAdapterTracker: (session) => session.name !== 'test' ? undefined : ({
      onDidSendMessage: (m) => {
        if (m.type === 'event' && m.event === 'stopped') stopped({ ...m.body, session });
        // The program's own output, which reaches the adapter through the pipes it was started with.
        if (m.type === 'event' && m.event === 'output' && ['stdout', 'stderr'].includes(m.body.category) && m.body.output.trim()) printed(m.body);
      },
    }),
  });
  try {
    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
      type: 'csharpshooter', request: 'launch', name: 'test', program, cwd: path.resolve(root(), d.cwd), env: d.env, justMyCode: true,
    });
    if (!started) return { ok: false, got: ['startDebugging returned false'] };
    const body = await Promise.race([stoppedEvent, sleep(120000).then(() => null)]);
    if (!body) return { ok: false, got: ['no stop within 120 s'] };
    const { session } = body; // not activeDebugSession, which may still be an earlier check's ending session
    const stack = await session.customRequest('stackTrace', { threadId: body.threadId, startFrame: 0, levels: 1 });
    const top = stack.stackFrames[0];
    if (!top) return { ok: false, got: [`stopped (${body.reason}) on thread ${body.threadId} with no frames`] };
    const value = await session.customRequest('evaluate', { expression: d.evaluate, frameId: top.id, context: 'watch' });
    await session.customRequest('continue', { threadId: body.threadId });
    // Only a program that prints (expectOutput) is waited for: WebApp writes nothing to its console for minutes.
    const output = d.expectOutput ? await Promise.race([printedEvent, sleep(60000).then(() => null)]) : undefined;
    await vscode.debug.stopDebugging(session);
    const at = `${path.basename(top.source?.path || '?')}:${top.line}`;
    const ok = path.basename(top.source?.path || '') === path.basename(d.breakpoint.file) && top.line === pos.line + 1 && (!d.expectOutput || output !== null);
    return { ok, got: [`stopped (${body.reason}) at ${at} in ${top.name}`, `${d.evaluate} = ${value.result}`,
      output ? `program ${output.category}: ${output.output.trim().slice(0, 80)}` : output === null ? 'no program output within 60 s' : 'output not checked'] };
  } finally {
    tracker.dispose();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  }
}

// The Solution view's tree, read through the provider the view shows, and Sync with Active Document.
async function solutionChecks(view) {
  const { provider } = view;
  const label = (i) => (typeof i.label === 'string' ? i.label : i.label.label);
  const children = async (item) => provider.getChildren(item);
  const child = async (item, name) => (await children(item)).find((i) => label(i) === name);
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });

  const [sln] = await children();
  expect('solution node', sln && label(sln) === "Solution 'WebApp'" && sln.description === '5 projects', `${label(sln)} (${sln.description})`);
  const projects = await children(sln);
  expect('projects', projects.map(label).join(',') === 'Contoso.Excel,Contoso.Core,Contoso.Lobby,WebApp,Tests', projects.map((p) => `${label(p)}${p.description ? ` [${p.description}]` : ''}`).join(', '));
  const web = projects.find((p) => label(p) === 'WebApp');
  const top = (await children(web)).map(label);
  expect('project tree like VS (no bin/obj/node_modules/.user)', top[0] === 'Dependencies' && top.includes('Views') && !top.some((n) => /^(bin|obj|node_modules)$|\.user$/.test(n)), top.join(', '));
  const deps = await child(web, 'Dependencies');
  const depGroups = await children(deps);
  const projRefs = (await children(depGroups.find((g) => label(g) === 'Projects'))).map(label);
  const packages = await children(depGroups.find((g) => label(g) === 'Packages'));
  const pkgNames = packages.map(label);
  expect('dependencies: project references', projRefs.includes('Contoso.Core'), projRefs.join(', '));
  expect('dependencies: packages, commented ones left out', pkgNames.includes('Newtonsoft.Json') && !pkgNames.includes('NuGet.Common'),
    packages.slice(0, 6).map((p) => `${label(p)} ${p.description}`).join(', '));
  const core = projects.find((p) => label(p) === 'Contoso.Core');
  const resx = await child(await child(core, 'Properties'), 'Resources.resx');
  const nested = resx ? (await children(resx)).map(label) : [];
  expect('file nesting (Resources.Designer.cs under .resx)', nested.includes('Resources.Designer.cs'), `Resources.resx > ${nested.join(', ')}`);

  const coach = vscode.Uri.file(path.resolve(root(), 'WebApp/Views/Employee/Coach.cshtml'));
  await vscode.window.showTextDocument(coach);
  await vscode.commands.executeCommand('csharpShooter.solution.syncWithActive');
  await sleep(1500);
  const selected = view.view.selection[0];
  expect('sync with active document', selected && selected.resourceUri?.fsPath.toLowerCase() === coach.fsPath.toLowerCase(),
    selected ? `selected ${label(selected)} (visible: ${view.view.visible})` : 'nothing selected');

  if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT);
  return results;
}

// The editor's own window only (PrintWindow), never the rest of the screen.
async function screenshot(file) {
  await sleep(1500);
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; } }
'@
$p = Get-Process VSCodium | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
$r = New-Object W+RECT; [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$b = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($b); $dc = $g.GetHdc()
[W]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$b.Save('${file.replace(/'/g, "''")}')`;
  require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', script]);
}

async function run() {
  const ext = vscode.extensions.getExtension('local.csharpshooter');
  const api = await ext.activate();
  const t0 = Date.now();
  await Promise.race([api.whenReady(), sleep(300000)]);
  const lines = [`projects loaded after ${((Date.now() - t0) / 1000).toFixed(1)} s`];
  const checks = process.env.CHECKS_FILE ? JSON.parse(fs.readFileSync(process.env.CHECKS_FILE, 'utf8')) : { checks: defaultChecks, debug: defaultDebug };
  let failed = 0;
  const deadline = Date.now() + 180000;
  for (const c of checks.checks) {
    const r = await check(c, deadline);
    failed += r.ok ? 0 : 1;
    lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${r.got.slice(0, 8).join(', ').slice(0, 200) || '(nothing)'}`);
  }
  if (checks.solution !== false && (!process.env.CHECKS_FILE || checks.solution)) {
    for (const r of await solutionChecks(api.solutionView)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  solution view: ${r.name}: ${r.got.join('; ').slice(0, 200)}`);
    }
  }
  if (checks.debug && process.env.SKIP_DEBUG !== '1') {
    const r = await debugCheck(checks.debug);
    failed += r.ok ? 0 : 1;
    lines.push(`${r.ok ? 'PASS' : 'FAIL'}  debug: ${r.got.join('; ')}`);
  }
  const report = lines.join('\n');
  console.log(report);
  if (process.env.REPORT_FILE) fs.writeFileSync(process.env.REPORT_FILE, report);
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
