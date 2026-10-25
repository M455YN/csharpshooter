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

const BREAK_IN_MAIN = { file: 'WebApp/Program.cs', needle: 'CreateHostBuilder(args).Build().Run();' };
const microsoftConfigs = [
  { label: 'coreclr launch (launchSettingsProfile)', breakpoint: BREAK_IN_MAIN, evaluate: 'System.Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")',
    expectValue: 'Development', config: { type: 'coreclr', request: 'launch', name: 'test', program: '${workspaceFolder}/WebApp/bin/Debug/net10.0/WebApp.dll',
      cwd: '${workspaceFolder}/WebApp', launchSettingsProfile: 'WebApp Development VSCode', sourceFileMap: { '/x': 'D:/x' } } },
  { label: 'dotnet launch (C# Dev Kit: projectPath, launchConfigurationId)', breakpoint: BREAK_IN_MAIN, evaluate: 'System.Environment.GetEnvironmentVariable("ASPNETCORE_URLS")',
    expectValue: 'https://localhost:44308', config: { type: 'dotnet', request: 'launch', name: 'test', projectPath: '${workspaceFolder}/WebApp/WebApp.csproj',
      launchConfigurationId: 'TargetFramework=net10.0;WebApp Development' } },
];

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

// d.config: a launch.json configuration of any type (coreclr, dotnet) to start instead of CSharpShooter's own; named 'test'.
async function debugCheck(d) {
  const program = d.program && path.resolve(root(), d.program);
  if (program && !fs.existsSync(program)) return { ok: false, got: [`not built: ${program}`] };
  const { doc, pos } = await position(d.breakpoint.file, d.breakpoint.needle, 0);
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(doc.uri, pos))]);
  let stopped, printed;
  const stoppedEvent = new Promise((r) => (stopped = r));
  const printedEvent = new Promise((r) => (printed = r));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('csharpshooter', {
    // This test's session only: one an earlier check stopped may still be ending.
    createDebugAdapterTracker: (session) => session.name !== 'test' ? undefined : ({
      onWillReceiveMessage: (m) => process.env.TRACE && console.log('[dap ->]', m.command, JSON.stringify(m.arguments || {}).slice(0, 200)),
      onError: (e) => process.env.TRACE && console.log('[dap error]', e.message),
      onExit: (code) => process.env.TRACE && console.log('[dap exit]', code),
      onDidSendMessage: (m) => {
        if (process.env.TRACE) console.log('[dap <-]', m.type, m.event || m.command, m.success === false ? m.message : '', m.event === 'output' ? m.body.output.slice(0, 150) : '');
        if (m.type === 'event' && m.event === 'stopped') stopped({ ...m.body, session });
        // The program's own output, which reaches the adapter through the pipes it was started with.
        if (m.type === 'event' && m.event === 'output' && ['stdout', 'stderr'].includes(m.body.category) && m.body.output.trim()) printed(m.body);
      },
    }),
  });
  try {
    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], d.config || {
      type: 'csharpshooter', request: 'launch', name: 'test', program, cwd: path.resolve(root(), d.cwd), env: d.env, justMyCode: true,
    });
    if (!started) return { ok: false, got: ['startDebugging returned false'] };
    const body = await Promise.race([stoppedEvent, sleep(d.config ? 240000 : 120000).then(() => null)]);
    if (!body) return { ok: false, got: ['no stop within the time given'] };
    const { session } = body; // not activeDebugSession, which may still be an earlier check's ending session
    const stack = await session.customRequest('stackTrace', { threadId: body.threadId, startFrame: 0, levels: 1 });
    const top = stack.stackFrames[0];
    if (!top) return { ok: false, got: [`stopped (${body.reason}) on thread ${body.threadId} with no frames`] };
    const value = await session.customRequest('evaluate', { expression: d.evaluate, frameId: top.id, context: 'watch' });
    // The debugger's own message in the UI's language (debug-l10n.js), Polish while the checks run.
    const unknown = await session.customRequest('evaluate', { expression: 'noSuchName_', frameId: top.id, context: 'watch' });
    // d.expectChild: a row the value shows when opened (EF Core's SQL of a query), a lazy row's value read as VS Code reads it.
    let children = [];
    if (d.expectChild && value.variablesReference) {
      for (const v of (await session.customRequest('variables', { variablesReference: value.variablesReference })).variables) {
        const lazy = v.presentationHint?.lazy && v.variablesReference
          ? (await session.customRequest('variables', { variablesReference: v.variablesReference })).variables[0]?.value : undefined;
        children.push(`${v.name}=${(lazy ?? v.value).replace(/\s+/g, ' ')}`);
      }
    }
    await session.customRequest('continue', { threadId: body.threadId });
    // Only a program that prints (expectOutput) is waited for: WebApp writes nothing to its console for minutes.
    const output = d.expectOutput ? await Promise.race([printedEvent, sleep(60000).then(() => null)]) : undefined;
    // Ended, its program with it, before the next check builds and starts that program again.
    const ended = new Promise((r) => { const d2 = vscode.debug.onDidTerminateDebugSession((x) => x.id === session.id && (d2.dispose(), r())); });
    await vscode.debug.stopDebugging(session);
    await Promise.race([ended, sleep(30000)]);
    const at = `${path.basename(top.source?.path || '?')}:${top.line}`;
    const ok = path.basename(top.source?.path || '') === path.basename(d.breakpoint.file) && top.line === pos.line + 1 && (!d.expectOutput || output !== null)
      && (!d.expectValue || value.result.includes(d.expectValue)) && unknown.result.startsWith('błąd: ')
      && (!d.expectChild || children.some((c) => c.includes(d.expectChild)));
    return { ok, got: [`${session.type} session`, `stopped (${body.reason}) at ${at} in ${top.name}`, `${d.evaluate} = ${value.result}`, `noSuchName_ = ${unknown.result.slice(0, 80)}`,
      ...(d.expectChild ? [`opened: ${children.find((c) => c.includes(d.expectChild)) || children.slice(0, 5).join(' | ')}`] : []),
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
  expect('solution node', sln && label(sln) === 'Rozwiązanie „WebApp”' && sln.description === '5 projektów', `${label(sln)} (${sln.description})`);
  const projects = await children(sln);
  expect('projects', projects.map(label).join(',') === 'Contoso.Excel,Contoso.Core,Contoso.Lobby,WebApp,Tests', projects.map((p) => `${label(p)}${p.description ? ` [${p.description}]` : ''}`).join(', '));
  const web = projects.find((p) => label(p) === 'WebApp');
  const top = (await children(web)).map(label);
  expect('project tree like VS (no bin/obj/node_modules/.user)', top[0] === 'Zależności' && top.includes('Views') && !top.some((n) => /^(bin|obj|node_modules)$|\.user$/.test(n)), top.join(', '));
  const deps = await child(web, 'Zależności');
  const depGroups = await children(deps);
  const projRefs = (await children(depGroups.find((g) => label(g) === 'Projekty'))).map(label);
  const packages = await children(depGroups.find((g) => label(g) === 'Pakiety'));
  const pkgNames = packages.map(label);
  expect('dependencies: project references', projRefs.includes('Contoso.Core'), projRefs.join(', '));
  expect('dependencies: packages, commented ones left out', pkgNames.includes('Newtonsoft.Json') && !pkgNames.includes('NuGet.Common'),
    packages.slice(0, 6).map((p) => `${label(p)} ${p.description}`).join(', '));
  // English: the same tree with csharpShooter.uiLanguage en, then Polish again.
  const ui = vscode.workspace.getConfiguration('csharpShooter');
  await ui.update('uiLanguage', 'en', vscode.ConfigurationTarget.Global);
  const [slnEn] = await children();
  const depsEn = (await children(projects.find((p) => label(p) === 'WebApp')))[0];
  const groupsEn = (await children(depsEn)).map(label);
  await ui.update('uiLanguage', 'pl', vscode.ConfigurationTarget.Global);
  expect('English with csharpShooter.uiLanguage en', label(slnEn) === "Solution 'WebApp'" && slnEn.description === '5 projects' && label(depsEn) === 'Dependencies' && groupsEn.includes('Packages'),
    `${label(slnEn)} (${slnEn.description}), ${label(depsEn)}: ${groupsEn.join(', ')}`);
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

  // Add → New Folder, Controller, View, in a folder of its own that is removed afterwards.
  const folder = await vscode.commands.executeCommand('csharpShooter.solution.addFolder', web, 'ShooterAddTest');
  try {
    const folderItem = await view.findItem(folder);
    expect('add folder', folderItem && fs.existsSync(folder), folderItem ? `tree shows ${label(folderItem)}` : 'not in tree');
    const controller = await vscode.commands.executeCommand('csharpShooter.solution.addController', folderItem, 'Probe', { baseClass: 'BaseController' });
    const code = controller ? fs.readFileSync(controller, 'utf8') : '';
    expect('add controller: file and template', /namespace WebApp\.ShooterAddTest\r?\n\{/.test(code) && code.includes('using Contoso.Core.Controllers;')
      && code.includes('public class ProbeController : BaseController') && code.includes('\r\n'), code.replace(/\r?\n/g, ' | ').slice(0, 200));
    // The language server takes the new file in: its base class resolves through the using it got.
    const { pos } = await position(controller, 'BaseController', 2);
    let hover = [];
    for (let i = 0; i < 20 && !hover.join().includes('Contoso.Core.Controllers'); i++) {
      hover = ((await vscode.commands.executeCommand('vscode.executeHoverProvider', vscode.Uri.file(controller), pos)) || [])
        .flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)));
      await sleep(3000);
    }
    expect('add controller: language server resolves its base class', hover.join().includes('Contoso.Core.Controllers'), hover.join(' ').replace(/\s+/g, ' ').slice(0, 120));
    const viewFile = await vscode.commands.executeCommand('csharpShooter.solution.addView', folderItem, 'Probe');
    const markup = viewFile ? fs.readFileSync(viewFile, 'utf8') : '';
    expect('add view (.cshtml)', viewFile?.endsWith('Probe.cshtml') && markup.includes('ViewData["Title"] = "Probe";'), markup.replace(/\r?\n/g, ' | '));
    await vscode.commands.executeCommand('workbench.view.extension.csharpShooter');
    await vscode.window.showTextDocument(vscode.Uri.file(controller));
    await vscode.commands.executeCommand('csharpShooter.solution.syncWithActive');
    await sleep(3000); // past the file watcher's refresh, which must not undo the reveal
    const shown = view.view.selection[0];
    expect('new file stays selected in the tree', shown?.resourceUri?.fsPath.toLowerCase() === controller.toLowerCase(), shown ? label(shown) : 'nothing selected');
    if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT);
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(folder, { recursive: true, force: true });
  }
  return results;
}

// Task Runner Explorer: the gulpfiles, their tasks and bindings, Project Open's watchers, a binding toggled and put back,
// and Before Build run as CSharpShooter's builds run it.
async function taskRunnerChecks(api) {
  const { runner } = api.taskRunner;
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const label = (n) => (typeof n.label === 'string' ? n.label : n.label.label);
  const files = await runner.getChildren();
  const where = files.map((f) => `${label(f)} (${f.description})`);
  expect('gulpfiles of the projects', ['WebApp', 'Contoso.Core', 'Contoso.Lobby'].every((p) => files.some((f) => f.description === p && f.kind === 'gulpfile')), where.join(', '));
  const sb = files.find((f) => f.description === 'WebApp' && f.kind === 'gulpfile');
  const [tasksGroup, bindingsGroup] = await runner.getChildren(sb);
  const taskRows = await runner.getChildren(tasksGroup);
  const tasks = taskRows.map(label);
  expect('tasks, as gulp lists them', ['beforeBuild', 'watchFiles_WebApp', 'minAllControlsSiteJS'].every((t) => tasks.includes(t)), tasks.join(', '));
  const bindings = await runner.getChildren(bindingsGroup);
  const shown = bindings.map((b) => `${label(b)}: ${b.tasks.join(', ')}`);
  expect('bindings from the /// <binding> line', shown.includes('Przed kompilacją (1): beforeBuild') && shown.includes('Otwarcie projektu (1): watchFiles_WebApp'), shown.join(' | '));

  const marks = taskRows.filter((r) => / b:/.test(r.contextValue)).map((r) => `${label(r)} [${r.contextValue.split(' ').slice(1).join(' ')}]`);
  expect('a task shows the events it is bound to (the Bindings menu checks them)',
    marks.includes('beforeBuild [b:BeforeBuild]') && marks.includes('watchFiles_WebApp [b:ProjectOpened]'), marks.join(', '));

  // Project Open: started as the workspace opened.
  for (let i = 0; i < 20 && runner.running.size < 3; i++) await sleep(500);
  const watching = [...runner.running.keys()].map((k) => k.split('|')[1]);
  // As VS runs them: node_modules\.bin first on PATH, gulp with --color.
  const exec = vscode.tasks.taskExecutions.find((e) => e.task.name.startsWith('watchFiles_WebApp'))?.task.execution;
  const pathValue = exec && Object.entries(exec.options?.env || {}).find(([k]) => k.toUpperCase() === 'PATH')?.[1];
  const binDir = path.join(path.dirname(sb.file), 'node_modules', '.bin');
  expect('runs with node_modules\\.bin first on PATH and --color', exec && exec.args.includes('--color') && pathValue?.startsWith(binDir),
    exec ? `${exec.process} ${exec.args.map((a) => path.basename(a)).join(' ')}; PATH starts ${pathValue?.slice(0, binDir.length)}` : 'no execution');
  expect('Project Open bindings started with the workspace', ['watchFiles_WebApp', 'watchFiles_ContosoCore', 'watchFiles_ContosoLobby'].every((w) => watching.includes(w)), watching.join(', '));
  if (process.env.SCREENSHOT) {
    await vscode.commands.executeCommand('workbench.view.extension.csharpShooter');
    await vscode.commands.executeCommand('csharpShooter.taskRunner.focus');
    await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-task-runner.png'));
  }
  for (const key of [...runner.running.keys()]) runner.stop(...key.split('|'));
  for (let i = 0; i < 30 && runner.running.size; i++) await sleep(500);
  expect('running tasks stop', runner.running.size === 0, runner.running.size ? `${runner.running.size} still running` : 'all stopped');

  // A binding toggled on and off again leaves the gulpfile as it was, its BOM included (Contoso.Lobby's has one).
  const lobby = files.find((f) => f.description === 'Contoso.Lobby' && f.kind === 'gulpfile').file;
  const before = fs.readFileSync(lobby);
  try {
    await vscode.commands.executeCommand('csharpShooter.taskRunner.bindAfterBuild', { file: lobby, task: 'beforeBuild' });
    const line = fs.readFileSync(lobby, 'utf8').split(/\r?\n/)[0];
    await vscode.commands.executeCommand('csharpShooter.taskRunner.bindAfterBuild', { file: lobby, task: 'beforeBuild' });
    const same = Buffer.compare(before, fs.readFileSync(lobby)) === 0;

    const lobbyNode = (await runner.getChildren()).find((f) => f.file === lobby);
    const afterBuild = async () => {
      const [, group] = await runner.getChildren(lobbyNode);
      const event = (await runner.getChildren(group)).find((b) => b.binding === 'AfterBuild');
      return event.tasks.length ? await runner.getChildren(event) : [];
    };
    for (const task of ['beforeBuild', 'watchFiles_ContosoLobby']) {
      await vscode.commands.executeCommand('csharpShooter.taskRunner.bindAfterBuild', { file: lobby, task });
    }
    const rows = await afterBuild();
    const placed = rows.map((r) => `${label(r)}[${r.contextValue.split(' ').filter((f) => f === 'up' || f === 'down').join(',')}]`).join(' ');
    await vscode.commands.executeCommand('csharpShooter.taskRunner.moveDown', rows[0]);
    const movedDown = (await afterBuild()).map(label).join(', ');
    await vscode.commands.executeCommand('csharpShooter.taskRunner.moveUp', (await afterBuild())[1]);
    const movedUp = (await afterBuild()).map(label).join(', ');
    for (const row of await afterBuild()) await vscode.commands.executeCommand('csharpShooter.taskRunner.removeBinding', row);
    const back = Buffer.compare(before, fs.readFileSync(lobby)) === 0;
    expect('binding order: move down, move up, remove (VS\'s Bindings tab)',
      placed === 'beforeBuild[down] watchFiles_ContosoLobby[up]' && movedDown === 'watchFiles_ContosoLobby, beforeBuild' && movedUp === 'beforeBuild, watchFiles_ContosoLobby' && back,
      `${placed} | down: ${movedDown} | up: ${movedUp} | removed, file ${back ? 'as it was' : 'DIFFERENT'}`);
    expect('toggle a binding, then back', line.includes("AfterBuild='beforeBuild'") && same, `${line.replace('\uFEFF', '<BOM>')} -> restored ${same ? 'byte for byte' : 'DIFFERENTLY'}`);
  } finally {
    fs.writeFileSync(lobby, before);
  }

  // Before Build, as a build of WebApp runs it when buildBindings is on.
  const config = vscode.workspace.getConfiguration('csharpShooter.taskRunner');
  await config.update('buildBindings', true, vscode.ConfigurationTarget.Global);
  try {
    const { buildBindings } = require(path.join(api.extensionPath, 'task-runner.js'));
    const t0 = Date.now();
    const ok = await buildBindings('BeforeBuild', path.dirname(sb.file));
    expect('a run ends saying its exit code', runner.lastExit?.task === 'beforeBuild' && runner.lastExit.code === 0,
      `Zadanie ${runner.lastExit?.task} zakończone z kodem zakończenia ${runner.lastExit?.code}`);
    expect('Before Build binding runs before a build', ok, `gulp beforeBuild ${ok ? 'succeeded' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } finally {
    await config.update('buildBindings', undefined, vscode.ConfigurationTarget.Global);
  }
  return results;
}

// With tasks.json's runOn: folderOpen watchers started by the editor: each runs once (Project Open leaves them to
// tasks.json), the Task Runner shows them running, and stops them.
async function autorunChecks(api) {
  const { runner } = api.taskRunner;
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const watchers = ['watchFiles_WebApp', 'watchFiles_ContosoCore', 'watchFiles_ContosoLobby'];
  const runsOf = (w) => vscode.tasks.taskExecutions.filter((e) => e.task.name.includes(w));
  for (let i = 0; i < 40 && !watchers.every((w) => runsOf(w).length); i++) await sleep(500);
  await sleep(3000); // and a moment more, for any second run to show
  const counts = watchers.map((w) => `${w}: ${runsOf(w).map((e) => e.task.name).join(' + ') || 'none'}`);
  expect("each watcher runs once (tasks.json's, not again by Project Open)", watchers.every((w) => runsOf(w).length === 1), counts.join(' | '));
  const rows = [];
  for (const f of (await runner.getChildren()).filter((n) => n.kind === 'gulpfile')) {
    const [tasksGroup] = await runner.getChildren(f);
    rows.push(...(await runner.getChildren(tasksGroup)).filter((r) => watchers.includes(r.task)));
  }
  expect("the Task Runner shows tasks.json's runs as running", rows.length === 3 && rows.every((r) => r.contextValue.startsWith('trTask.running')),
    rows.map((r) => `${r.task}: ${r.description || 'idle'}`).join(', '));
  for (const r of rows) await vscode.commands.executeCommand('csharpShooter.taskRunner.stop', r);
  for (let i = 0; i < 30 && watchers.some((w) => runsOf(w).length); i++) await sleep(500);
  expect('and stops them', watchers.every((w) => !runsOf(w).length), watchers.map((w) => `${w}: ${runsOf(w).length}`).join(', '));
  return results;
}

// What the Run and Debug view offers: its configuration list and Select and Start Debugging's picker, photographed.
async function runViewProbe() {
  await vscode.commands.executeCommand('workbench.view.debug');
  await sleep(2000);
  await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-run-view.png'));
  vscode.commands.executeCommand('workbench.action.debug.selectandstart');
  await sleep(2500);
  await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-select-and-start.png'));
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  return [];
}

// launch.json with the launch profiles in it (csharpShooter.launchProfilesInLaunchJson: always): listed in Run and Debug
// as VS lists them, the workspace's own entries kept, and one started by its name as F5 starts the selected one.
async function launchJsonChecks() {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const configs = () => vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders[0].uri).get('configurations') || [];
  for (let i = 0; i < 40 && !configs().some((c) => c.type === 'csharpshooter'); i++) await sleep(500);
  const names = configs().map((c) => c.name);
  expect('launch profiles are in launch.json, the existing entry kept',
    ['Projekt startowy (CSharpShooter)', 'WebApp: WebApp Development', 'WebApp: WebApp Development VSCode', 'Contoso.Lobby: Contoso.Lobby Development'].every((n) => names.includes(n)) && configs()[0].type === 'coreclr',
    names.join(' | '));
  const entry = configs().find((c) => c.name === 'WebApp: WebApp Development');
  expect('an entry names the project relative to the folder', entry?.project === '${workspaceFolder}/WebApp/WebApp.csproj' && entry.launchProfile === 'WebApp Development',
    JSON.stringify(entry));
  if (process.env.SCREENSHOT) {
    await vscode.commands.executeCommand('workbench.view.debug');
    vscode.commands.executeCommand('workbench.action.debug.selectandstart');
    await sleep(2500);
    await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-launch-json.png'));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  }
  // Started by its name, as F5 starts the configuration the dropdown has selected; its build is skipped here.
  let session;
  const started = new Promise((r) => { const d = vscode.debug.onDidStartDebugSession((s) => (d.dispose(), r(s))); });
  const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], 'WebApp: WebApp Development');
  session = ok ? await Promise.race([started, sleep(240000).then(() => null)]) : null;
  expect('started by its name, as F5 does', session?.type === 'csharpshooter' && session.configuration.env?.ASPNETCORE_ENVIRONMENT === 'Development',
    session ? `${session.type} session "${session.name}", ASPNETCORE_ENVIRONMENT=${session.configuration.env?.ASPNETCORE_ENVIRONMENT}` : 'no session');
  if (session) {
    const ended = new Promise((r) => { const d = vscode.debug.onDidTerminateDebugSession((x) => x.id === session.id && (d.dispose(), r())); });
    await vscode.debug.stopDebugging(session);
    await Promise.race([ended, sleep(30000)]);
  }
  return results;
}

// Startup project and active profile as VS keeps them: read from VS's .suo and .csproj.user, shown in the status bar and
// the Solution Explorer, changed from there, and run by F5 and Ctrl+F5 on the "Projekt startowy" entry. The projects'
// .csproj.user files are put back as they were.
async function startupChecks(api) {
  const { startup, status } = api.startup;
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const label = (n) => (typeof n.label === 'string' ? n.label : n.label.label);
  const proj = (name) => path.resolve(root(), name, `${name}.csproj`);
  const userFiles = ['WebApp', 'Contoso.Lobby'].map((p) => `${proj(p)}.user`);
  const saved = userFiles.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
  const folder = vscode.workspace.workspaceFolders[0];
  try {
    expect("startup project read from VS's .suo", path.basename(await startup.project()) === 'WebApp.csproj', await startup.project());
    expect("active profile read from VS's .csproj.user (ActiveDebugProfile)", startup.profile(proj('WebApp')) === 'WebApp Development', startup.profile(proj('WebApp')));
    await sleep(1000);
    expect('status bar: startup project and the start button with its profile', status.project.includes('WebApp') && status.start.includes('WebApp Development'),
      `${status.project} | ${status.start}`);

    expect("status bar as VS's toolbar: the solution's configuration and platform, restart grey while not debugging",
      status.configuration === 'Debug' && status.platform === 'Any CPU' && status.restart === false, `${status.configuration} | ${status.platform} | restart ${status.restart}`);
    // A solution configuration builds each project as the .sln maps it; Release is passed to dotnet as -c Release.
    const { configurations } = await startup.solutionSettings();
    await vscode.commands.executeCommand('csharpShooter.startup.pickConfiguration', 'Release');
    await sleep(500);
    const mapped = await startup.buildSettings(proj('WebApp'));
    const odd = configurations.find((c) => !['Debug', 'Release'].includes(c));
    await vscode.commands.executeCommand('csharpShooter.startup.pickConfiguration', odd || 'Debug');
    const oddMapped = await startup.buildSettings(proj('WebApp'));
    await vscode.commands.executeCommand('csharpShooter.startup.pickConfiguration', 'Debug');
    await sleep(500);
    expect('Konfiguracje rozwiązania: the choice shows and maps to each project as the .sln says',
      mapped.configuration === 'Release' && (!odd || ['Debug', 'Release'].includes(oddMapped.configuration)) && status.configuration === 'Debug',
      `Release -> ${JSON.stringify(mapped)}, ${odd} -> ${JSON.stringify(oddMapped)}, now ${status.configuration}`);
    const rows = async () => (await api.solutionView.provider.getChildren((await api.solutionView.provider.getChildren())[0]));
    const marks = async () => (await rows()).map((r) => `${label(r)}[${r.contextValue}]${r.description ? ` (${r.description})` : ''}`).join(', ');
    let shown = await marks();
    expect('Solution Explorer marks the startup project; runnable ones only can become it',
      shown.includes('WebApp[project runnable startup] (web · projekt startowy)') && shown.includes('Contoso.Lobby[project runnable] (web)') && shown.includes('Contoso.Core[project]'), shown);

    const refused = await vscode.commands.executeCommand('csharpShooter.startup.setProject', proj('Contoso.Core'));
    expect('a class library cannot be the startup project (VS\'s message)', refused === false && path.basename(await startup.project()) === 'WebApp.csproj', `setProject(Contoso.Core) -> ${refused}`);

    await vscode.commands.executeCommand('csharpShooter.startup.setProject', (await rows()).find((r) => label(r) === 'Contoso.Lobby'));
    await vscode.commands.executeCommand('csharpShooter.startup.selectProfile', proj('Contoso.Lobby'), 'Contoso.Lobby Development VSCode');
    await sleep(1000);
    shown = await marks();
    const written = fs.readFileSync(`${proj('Contoso.Lobby')}.user`, 'utf8').match(/<ActiveDebugProfile>([^<]*)</)?.[1];
    expect('Ustaw jako projekt startowy, and a profile chosen: written to .csproj.user as VS writes it',
      path.basename(await startup.project()) === 'Contoso.Lobby.csproj' && written === 'Contoso.Lobby Development VSCode' && status.start.includes('Contoso.Lobby Development VSCode') && shown.includes('Contoso.Lobby[project runnable startup]'),
      `startup ${path.basename(await startup.project())}, ActiveDebugProfile=${written}, status ${status.project} | ${status.start}`);

    // F5 on the startup entry: WebApp again, with its profile from .csproj.user.
    await vscode.commands.executeCommand('csharpShooter.startup.setProject', proj('WebApp'));
    const started = new Promise((r) => { const d = vscode.debug.onDidStartDebugSession((s) => (d.dispose(), r(s))); });
    const ok = await vscode.debug.startDebugging(folder, api.startup.startupEntry());
    let session = ok ? await Promise.race([started, sleep(240000).then(() => null)]) : null;
    expect('F5 on "Projekt startowy (CSharpShooter)" runs the startup project with its active profile',
      session?.name === 'WebApp: WebApp Development' && session.configuration.env?.ASPNETCORE_ENVIRONMENT === 'Development',
      session ? `${session.type} session "${session.name}", ASPNETCORE_ENVIRONMENT=${session.configuration.env?.ASPNETCORE_ENVIRONMENT}` : 'no session');
    if (session) {
      expect('Uruchom ponownie (status bar) is live while debugging', status.restart === true, `restart ${status.restart}`);
      if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-toolbar.png'));
      // Uruchom ponownie while it runs: the app gone before the build, built again, a new session.
      const first = session;
      const next = new Promise((r) => { const d = vscode.debug.onDidStartDebugSession((x) => x.id !== first.id && (d.dispose(), r(x))); });
      api.launch.state.lastBuild = undefined;
      await vscode.commands.executeCommand('csharpShooter.restart');
      session = (await Promise.race([next, sleep(240000).then(() => null)])) || first;
      expect('Uruchom ponownie while debugging: the app stopped, built again, a new session', session !== first && api.launch.state.lastBuild?.ok,
        `session ${session === first ? '(none new)' : session.name}, build ${JSON.stringify(api.launch.state.lastBuild?.ok)}, stopped ${JSON.stringify(api.launch.state.lastStopped)}`);
      const ended = new Promise((r) => { const d = vscode.debug.onDidTerminateDebugSession((x) => x.id === session.id && (d.dispose(), r())); });
      await vscode.debug.stopDebugging(session);
      await Promise.race([ended, sleep(30000)]);
    }

    // Uruchom ponownie during the build: that build stops and gives way, one start goes on.
    {
      let sessions = 0;
      const counting = vscode.debug.onDidStartDebugSession(() => sessions++);
      const firstStart = vscode.debug.startDebugging(folder, api.startup.startupEntry());
      for (let i = 0; i < 40 && !api.launch.state.starting?.size; i++) await sleep(250);
      await sleep(2000);
      const building = api.launch.state.lastProgress.lines.join(' | ');
      const next = new Promise((r) => { const d = vscode.debug.onDidStartDebugSession((x) => (d.dispose(), r(x))); });
      api.launch.state.lastBuild = undefined;
      await vscode.commands.executeCommand('csharpShooter.restart');
      const firstOk = await firstStart;
      const again = await Promise.race([next, sleep(240000).then(() => null)]);
      await sleep(1000);
      counting.dispose();
      expect('Uruchom ponownie during the build: that build stops, the start goes on once', firstOk === false && again && api.launch.state.lastBuild?.ok && sessions === 1,
        `first start ${firstOk} (was: ${building}), sessions ${sessions}, build ${JSON.stringify(api.launch.state.lastBuild?.ok)}`);
      if (again) {
        const ended = new Promise((r) => { const d = vscode.debug.onDidTerminateDebugSession((x) => x.id === again.id && (d.dispose(), r())); });
        await vscode.debug.stopDebugging(again);
        await Promise.race([ended, sleep(30000)]);
      }
    }

    // Ctrl+F5: no debug session; the program in a task, the browser once it listens.
    api.launch.state.browserUrl = undefined;
    let debugSessions = 0;
    const counting = vscode.debug.onDidStartDebugSession(() => debugSessions++);
    await vscode.debug.startDebugging(folder, api.startup.startupEntry(), { noDebug: true });
    const run = api.launch.state.lastRunWithoutDebugging;
    for (let i = 0; i < 180 && run && !api.launch.state.browserUrl; i++) await sleep(1000);
    counting.dispose();
    expect('Ctrl+F5 runs it without the debugger, the browser once it listens',
      run?.name === 'WebApp: WebApp Development' && debugSessions === 0 && api.launch.state.browserUrl === 'https://localhost:44308/',
      `task "${run?.name}", debug sessions ${debugSessions}, browser ${api.launch.state.browserUrl}`);
    // Uruchom ponownie while it runs without the debugger: the program stopped, built and run again.
    if (run) {
      api.launch.state.browserUrl = undefined;
      api.launch.state.lastBuild = undefined;
      await vscode.commands.executeCommand('csharpShooter.restart');
      for (let i = 0; i < 180 && !api.launch.state.browserUrl; i++) await sleep(1000);
      const rerun = api.launch.state.lastRunWithoutDebugging;
      expect('Uruchom ponownie after Ctrl+F5: the program stopped, built and run again', api.launch.state.lastStopped?.length > 0 && api.launch.state.lastBuild?.ok
        && rerun !== run && api.launch.state.browserUrl, `stopped ${JSON.stringify(api.launch.state.lastStopped)}, build ${api.launch.state.lastBuild?.ok}, new run ${rerun !== run}, browser ${api.launch.state.browserUrl}`);
    }
    for (const r of new Set([run, api.launch.state.lastRunWithoutDebugging].filter(Boolean))) {
      if (!vscode.tasks.taskExecutions.includes(r.execution)) continue;
      const ended = new Promise((res) => { const d = vscode.tasks.onDidEndTask((e) => e.execution === r.execution && (d.dispose(), res())); });
      r.execution.terminate();
      await Promise.race([ended, sleep(30000)]);
    }
  } finally {
    userFiles.forEach((f, i) => (saved[i] ? fs.writeFileSync(f, saved[i]) : fs.rmSync(f, { force: true })));
  }
  const back = userFiles.every((f, i) => saved[i] && Buffer.compare(saved[i], fs.readFileSync(f)) === 0);
  expect('.csproj.user files put back as they were', back, back ? 'byte for byte' : 'DIFFERENT');
  return results;
}

// The editor's own window only (PrintWindow), never the rest of the screen.
// Solution Explorer's search, as VS's: names from the index (VS's matching rules), the tree filtered to the hits and
// their folders, "Szukaj w zawartościach plików" through ripgrep with the lines under the files, the box (Ctrl+;).
async function searchChecks(api, ext) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const label = (n) => (typeof n.label === 'string' ? n.label : n.label.label);
  const { provider, view, search } = api.solutionView;
  const { matcher } = search;
  const m = (q, name) => JSON.stringify(matcher(q)(name));
  expect("VS's matching: words anywhere, case only with a capital, HC for HomeController, \"phrases\"",
    m('home', 'HomeController.cs') === '[[0,4]]' && m('Home', 'homepage.js') === 'null' && m('HC', 'HomeController.cs') === '[[0,1],[4,5]]'
      && m('view login', 'LoginViewModel.cs') !== 'null' && m('"view login"', 'LoginViewModel.cs') === 'null',
    ['home', 'Home', 'HC', 'view login', '"view login"'].map((q) => `${q} -> ${m(q, q === 'Home' ? 'homepage.js' : q === 'HC' ? 'HomeController.cs' : 'LoginViewModel.cs')}`).join(' | '));

  // The tree as shown: every expanded row, indented.
  const shown = async () => {
    const out = [];
    const walk = async (item, depth) => {
      for (const c of await provider.getChildren(item)) {
        out.push(`${'  '.repeat(depth)}${label(c)}`);
        if (c.collapsibleState === vscode.TreeItemCollapsibleState.Expanded && depth < 12) await walk(c, depth + 1);
      }
    };
    await walk(undefined, 0);
    return out;
  };

  await vscode.commands.executeCommand('csharpShooter.solution.search', '');
  const before = await shown();
  let t = Date.now();
  let r = await vscode.commands.executeCommand('csharpShooter.solution.search', 'LoginViewModel');
  const cold = Date.now() - t;
  t = Date.now();
  await search.search('LoginViewModel');
  const warm = Date.now() - t;
  let rows = await shown();
  const files = rows.filter((x) => x.trim() === 'LoginViewModel.cs');
  expect('names: the tree filtered to the hits, their folders and projects open, other projects gone',
    files.length === 2 && rows.some((x) => x.trim() === 'ViewModels') && !rows.some((x) => /Zależności|Contoso\.Excel|Tests$/.test(x)) && !rows.some((x) => x.includes('WorktimeLog')),
    rows.join(' / '));
  expect('names: instant from the index (built once, then searched in memory)', warm < 150, `first ${cold} ms (index built), then ${warm} ms`);

  // A file added and removed on disk: the index follows it, as VS's follows the items added and removed.
  const probe = path.resolve(root(), 'WebApp', 'ViewModels', 'ShooterSearchProbe.cs');
  let added;
  let removed;
  try {
    fs.writeFileSync(probe, '// probe');
    for (let i = 0; i < 20 && !(added = (await search.search('ShooterSearchProbe')).names); i++) await sleep(250);
  } finally {
    fs.rmSync(probe, { force: true });
  }
  for (let i = 0; i < 20 && (removed = (await search.search('ShooterSearchProbe')).names); i++) await sleep(250);
  t = Date.now();
  await search.search('LoginViewModel');
  const afterChange = Date.now() - t;
  expect('names: a file added and removed on disk comes and goes, the index kept (not built anew)', added === 1 && removed === 0 && afterChange < 150,
    `added: ${added} hit, removed: ${removed}, then a search ${afterChange} ms`);

  r = await vscode.commands.executeCommand('csharpShooter.solution.search', 'HC');
  rows = await shown();
  expect('names: HC finds HomeController.cs', rows.some((x) => x.trim() === 'HomeController.cs'), `${r.names} hits: ${rows.filter((x) => /HomeController/.test(x)).join(', ')}`);

  await search.search('CheckRightsExpr', true);
  t = Date.now();
  r = await search.search('CheckRightsExpr', true);
  const grepMs = Date.now() - t;
  rows = await shown();
  const at = rows.findIndex((x) => x.trim() === 'RightsChecker.cs');
  expect('file contents (ripgrep): the files with the text, their lines under them',
    r.lines > 0 && at >= 0 && rows[at + 1]?.includes('CheckRightsExpr') && rows.some((x) => x.trim() === 'AppUser.cs'),
    `${r.lines} lines in ${r.files.length} files, ${grepMs} ms: ${rows.slice(Math.max(0, at - 2), at + 3).map((x) => x.trim()).join(' / ')}`);

  r = await search.search('zzqqxxnothing');
  expect("no hits: VS's message in the tree", view.message === 'Brak wyników.' && (await provider.getChildren((await provider.getChildren())[0])).length === 0, view.message);

  await vscode.commands.executeCommand('csharpShooter.solution.search', '');
  const after = await shown();
  expect('cleared: the whole tree back', JSON.stringify(after) === JSON.stringify(before) && !view.message, `${before.length} rows before, ${after.length} after`);

  const key = ext.packageJSON.contributes.keybindings.find((k) => k.command === 'csharpShooter.solution.search');
  const box = ext.packageJSON.contributes.views.csharpShooter[0];
  let focused = true;
  try {
    await vscode.commands.executeCommand('csharpShooter.solution.search');
  } catch (e) {
    focused = e.message;
  }
  for (let i = 0; i < 20 && !search.boxShown(); i++) await sleep(250);
  expect('the box above the tree, Ctrl+; to it', key?.key === 'ctrl+;' && box.id === 'csharpShooter.search' && box.type === 'webview' && focused === true && search.boxShown(),
    `${key?.key}, first view ${box.id} (${box.type}), focus: ${focused}, box drawn: ${search.boxShown()}`);
  if (process.env.SCREENSHOT) {
    await vscode.commands.executeCommand('csharpShooter.solution.search', 'Login');
    await sleep(1500);
    await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-search.png'));
    await vscode.commands.executeCommand('csharpShooter.solution.search', '');
  }
  return results;
}

// The full-screen search, as VS's "Szukaj wszędzie" with Find in Files: its filters and prefixes, symbols from the
// language server, text through ripgrep with VS's options, scope and file types, Find in Files' summary, the panel.
async function searchEverywhereChecks(api) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const { search, parseQuery, state } = api.searchEverywhere;
  const p = (q) => JSON.stringify(parseQuery(q, 'code'));
  expect('prefixes f: t: m: pick the filter, as in VS', parseQuery('f:Login', 'code').filter === 'files' && parseQuery('t: Login', 'code').filter === 'types'
    && parseQuery('m:Check', 'text').filter === 'members' && parseQuery('Login', 'text').filter === 'text', ['f:Login', 't: Login', 'm:Check'].map(p).join(' | '));
  const labels = (r, g) => (r.groups[g] || []).map((i) => i.label);

  let r = await search('f:LoginViewModel');
  expect('Pliki (f:): the solution\'s files by name, from the index', labels(r, 'files').filter((l) => l === 'LoginViewModel.cs').length === 2 && !r.groups.types,
    `${labels(r, 'files').join(', ')} | ${r.summary}`);
  // The language server may still be indexing: asked again for a while.
  for (let i = 0; i < 30 && !(r = await search('t:LoginViewModel')).groups.types?.length; i++) await sleep(1000);
  const type = r.groups.types?.find((i) => i.label === 'LoginViewModel');
  expect('Typy (t:): classes from the language server, kind and file', type && type.detail.startsWith('klasa') && type.path.endsWith('LoginViewModel.cs') && type.line > 0,
    (r.groups.types || []).map((i) => `${i.label} [${i.detail}]:${i.line}`).slice(0, 4).join(' | '));
  r = await search('m:CheckRightsExpr');
  const member = r.groups.members?.find((i) => i.label.startsWith('CheckRightsExpr'));
  expect('Elementy członkowskie (m:): methods, not types', member && member.detail.startsWith('metoda') && member.path.endsWith('RightsChecker.cs') && !r.groups.types,
    (r.groups.members || []).map((i) => `${i.label} [${i.detail}]`).slice(0, 3).join(' | '));
  r = await search('LoginViewModel', { filter: 'code' });
  expect('Kod: files, types and members together', r.groups.files?.length >= 2 && r.groups.types?.length >= 1 && 'members' in r.groups, r.summary);

  r = await search('CheckRightsExpr', { filter: 'text' });
  const textLines = r.groups.text || [];
  expect("Tekst: Find in Files' lines and its summary", textLines.length >= 10 && /^Pasujące wiersze: \d+ {4}Pasujące pliki: \d+ {4}Łączna liczba przeszukanych plików: \d+$/.test(r.summary)
    && textLines.every((l) => l.label.slice(l.ranges[0]?.[0], l.ranges[0]?.[1]) === 'CheckRightsExpr'), r.summary);
  const all = textLines.length;
  r = await search('checkrightsexpr', { filter: 'text', matchCase: true });
  const lower = r.groups.text?.length || 0;
  r = await search('checkrightsexpr', { filter: 'text' });
  expect('Uwzględnij wielkość liter: on, the lowercase query finds nothing; off, all', lower === 0 && r.groups.text?.length === all, `on: ${lower}, off: ${r.groups.text?.length}, CheckRightsExpr: ${all}`);
  r = await search('CheckRights\\w+\\(conditions', { filter: 'text', regex: true });
  const viaRegex = r.groups.text || [];
  expect('Użyj wyrażeń regularnych', viaRegex.length > 0 && viaRegex.length < all && viaRegex.every((l) => /CheckRights\w+\(conditions/.test(l.label)), `${viaRegex.length} lines: ${viaRegex[0]?.label}`);
  r = await search('CheckRights', { filter: 'text', wholeWord: true });
  const words = r.groups.text || [];
  expect('Dopasuj całe wyrazy: CheckRights is not CheckRightsExpr', words.every((l) => !/CheckRightsExpr/.test(l.label.slice(l.ranges[0]?.[0] ?? 0))), `${words.length} lines (CheckRightsExpr: ${all})`);
  r = await search('CheckRightsExpr', { filter: 'text', fileTypes: '*.cshtml' });
  expect('Typy plików: only those files', (r.groups.text || []).every((l) => l.path.endsWith('.cshtml')) && (r.groups.text || []).length < all, `${(r.groups.text || []).length} lines in .cshtml`);
  const checker = vscode.Uri.file(member.path); // the one the language server knows (copies of it are synced into other projects)
  await vscode.window.showTextDocument(checker);
  r = await search('CheckRightsExpr', { filter: 'text', scope: 'document' });
  expect('Szukaj w: Bieżący dokument', (r.groups.text || []).length > 0 && r.groups.text.every((l) => l.path.toLowerCase() === checker.fsPath.toLowerCase()), r.summary);
  r = await search('CheckRightsExpr', { filter: 'text', scope: 'project' });
  const projectDir = path.dirname(checker.fsPath).toLowerCase().split(/[\\/]authorization/)[0];
  expect('Szukaj w: Bieżący projekt', (r.groups.text || []).length > 0 && r.groups.text.every((l) => l.path.toLowerCase().startsWith(projectDir)) && r.groups.text.length < all, r.summary);
  r = await search('(', { filter: 'text', regex: true });
  const bad = r.message;
  r = await search('Search Solution Explorer', { filter: 'features' });
  expect('Funkcje: commands by title, and settings and the palette for the rest', labels(r, 'features').includes('Solution: Search Solution Explorer')
    && labels(r, 'features').some((l) => l.startsWith('Ustawienia')) && !!bad, `${labels(r, 'features').slice(0, 3).join(' | ')}; bad regex: ${bad}`);

  // The panel: opened by Ctrl+T's command with a query, drawn, then Find in Files (Ctrl+Shift+F) on it.
  await vscode.commands.executeCommand('csharpShooter.searchEverywhere', 'LoginViewModel');
  for (let i = 0; i < 40 && !(state.ready && state.last?.query === 'LoginViewModel'); i++) await sleep(250);
  const shownCode = state.ready && state.last?.query === 'LoginViewModel';
  if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-everywhere.png'));
  await vscode.commands.executeCommand('csharpShooter.findInFiles', 'CheckRightsExpr');
  for (let i = 0; i < 40 && !(state.last?.filter === 'text' && state.last?.summary); i++) await sleep(250);
  expect('the panel (Ctrl+T, Ctrl+Shift+F) searches as it is typed into', shownCode && state.last?.filter === 'text' && state.last.summary.startsWith('Pasujące wiersze'),
    `ready: ${state.ready}, last: ${state.last?.filter} "${state.last?.query}" ${state.last?.summary}`);
  if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-find-in-files.png'));
  // ⤢ in the Solution Explorer's box, and the search icon on its title: the same query in this panel.
  await api.solutionView.search.fullscreen('HomeController');
  for (let i = 0; i < 40 && state.last?.query !== 'HomeController'; i++) await sleep(250);
  const icon = vscode.extensions.getExtension('M455YN.csharpshooter').packageJSON.contributes.menus['view/title'].find((m) => m.command === 'csharpShooter.searchEverywhere');
  expect('the Solution Explorer box (⤢) and title open it with their query', state.last?.query === 'HomeController' && state.last.groups.files?.length > 0 && icon?.when.includes('csharpShooter.solution'),
    `"${state.last?.query}" ${state.last?.summary}; title icon: ${icon?.when}`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  return results;
}

// Razor files as VS and Passenger open them (aspnetcorerazor, Razor's own completion): typed as a person types, the
// list stays open through an attribute's '-', its item goes in; a tag helper's own attributes; asp-for's value; '@'.
// Nothing is saved: each file is reverted.
async function razorTypingChecks() {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const labels = (list) => (list?.items || []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  const type = async (text, gap = 150) => {
    for (const ch of text) {
      await vscode.commands.executeCommand('type', { text: ch });
      await sleep(gap);
    }
  };
  // A new line above `needle`'s, indented as it, the cursor on it.
  const freshLine = async (file, needle) => {
    const doc = await vscode.workspace.openTextDocument(path.resolve(root(), file));
    const editor = await vscode.window.showTextDocument(doc);
    const at = doc.positionAt(doc.getText().indexOf(needle));
    await editor.edit((e) => e.insert(new vscode.Position(at.line, 0), `${' '.repeat(at.character)}\n`));
    const start = new vscode.Position(at.line, at.character);
    editor.selection = new vscode.Selection(start, start);
    // VS Code's Chat beside the editor takes the focus a while after the window opens; keys typed then go to it.
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await sleep(300);
    return { doc, editor, line: at.line };
  };
  // Waits for the list (asked as VS Code asks while typing), then takes its selected item.
  const accept = async () => {
    await sleep(2500);
    await vscode.commands.executeCommand('acceptSelectedSuggestion');
    await sleep(500);
  };
  const revert = () => vscode.commands.executeCommand('workbench.action.files.revert');

  const login = 'WebApp/Views/Pass/Login.cshtml';
  let { doc, editor, line } = await freshLine(login, '<input asp-for');
  expect('a .cshtml opens as aspnetcorerazor, with quick suggestions in strings', doc.languageId === 'aspnetcorerazor'
    && vscode.workspace.getConfiguration('editor', doc).get('quickSuggestions').strings === 'on', `${doc.languageId}, ${JSON.stringify(vscode.workspace.getConfiguration('editor', doc).get('quickSuggestions'))}`);
  await type('<input ');
  const items = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, editor.selection.active);
  const aspFor = items?.items.find((i) => (i.label.label || i.label) === 'asp-for');
  expect("Razor's list: no C# commit characters ('-' does not take an item)", aspFor && !(aspFor.commitCharacters || []).includes('-'),
    `asp-for commits on: ${JSON.stringify(aspFor?.commitCharacters)}`);
  await type('asp-f');
  const typed = doc.lineAt(line).text.trim();
  await accept();
  const taken = doc.lineAt(line).text.trim();
  expect('typing <input asp-f: the list stays open through "-", asp-for goes in', typed === '<input asp-f' && /^<input asp-for/.test(taken), `typed: ${typed} → ${taken}`);
  await revert();

  // asp-for's value: the model's properties, typed inside the quotes.
  ({ doc, editor, line } = await freshLine(login, '<input asp-for'));
  await type('<input asp-for="', 120);
  await sleep(1500);
  const quote = doc.lineAt(line).text.indexOf('"', doc.lineAt(line).text.indexOf('asp-for')) + 1;
  editor.selection = new vscode.Selection(line, quote, line, quote);
  const values = labels(await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, quote)));
  await type('Lo');
  await accept();
  const value = doc.lineAt(line).text.trim();
  expect("asp-for's value: the model's properties as it is typed", values.includes('Login') && /asp-for="Login/.test(value), `${values.filter((v) => /^Lo/.test(v)).join(', ')} | ${value}`);
  await revert();

  // A tag helper of the solution's own (page-title): its attributes, '-' in them typed through.
  const coach = 'WebApp/Views/Employee/Coach.cshtml';
  ({ doc, editor, line } = await freshLine(coach, '<page-title '));
  await type('<page-title ');
  const own = labels(await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, editor.selection.active));
  await type('icon-n');
  await accept();
  const ownLine = doc.lineAt(line).text.trim();
  expect("the solution's own tag helper: its attributes listed, icon-name typed through '-' and taken", own.includes('icon-name') && /^<page-title icon-name/.test(ownLine),
    `${own.filter((o) => /icon|title|visible/.test(o)).join(', ')} | ${ownLine}`);
  await revert();

  // Enter at the end of a line, as a person presses it, then what the list took (nothing when none opened).
  const enterAfter = async (file, needle) => {
    const doc = await vscode.workspace.openTextDocument(path.resolve(root(), file));
    const editor = await vscode.window.showTextDocument(doc);
    const end = doc.lineAt(doc.positionAt(typeof needle === 'string' ? doc.getText().indexOf(needle) : doc.getText().search(needle)).line).range.end;
    editor.selection = new vscode.Selection(end, end);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await sleep(300);
    await vscode.commands.executeCommand('type', { text: '\n' });
    await accept();
    const got = doc.lineAt(end.line + 1).text.trim();
    await revert();
    return got;
  };
  // Enter among a tag helper's attributes (its select a multi-line @(@"...") string): the attributes, as after a space.
  const coachGrid = await enterAfter('WebApp/Views/Employee/Coach.cshtml', /row-number-p="true"\r?\n\s*relative-directory-path="@AttributeDirectory"\r?\n\s*select="@\(@"\r?\n--declare @status/);
  expect("Enter among a tag's attributes opens Razor's list of them", /^[a-z][a-z-]*(="")?$/.test(coachGrid) && coachGrid !== 'relative-directory-path', coachGrid || '(no list)');
  const markup = await enterAfter(login, '<div class="input-group">');
  const code = await enterAfter('WebApp/Views/Employee/Coach.cshtml', 'string control = "coach-info-grid";');
  expect('Enter in markup or in C# opens nothing', markup === '' && code === '', `markup: ${markup || '(nothing)'}, C#: ${code || '(nothing)'}`);

  // '@' in markup: Razor's directives and the C# (a trigger character of Razor's, not of C#'s).
  ({ doc, editor, line } = await freshLine(login, '<input asp-for'));
  await type('@');
  const at = labels(await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, editor.selection.active, '@'));
  await type('Model'); // "Mod" alone is a class of the solution's own, which the list rightly puts first
  await sleep(2500);
  if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT.replace(/.png$/i, '-at-model.png'));
  await accept();
  const atLine = doc.lineAt(line).text.trim();
  const around = [line - 1, line, line + 1].map((n) => doc.lineAt(n).text.trim()).join(' ⏎ ') + ` (lang ${doc.languageId}, active ${path.basename(vscode.window.activeTextEditor?.document.fileName || '')})`;
  expect("'@': the C# and Razor's directives, @Model taken", at.includes('Model') && atLine.startsWith('@Model'), `${at.length} items (${['Model', 'using', 'if'].filter((x) => at.includes(x)).join(', ')}) | ${around}`);
  await revert();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  return results;
}

// The DataTable visualizer at a breakpoint: a table the program makes (a helper of the solution's own: 450 rows of
// Value and Sort), read a page at a time; its filter and sort; copy and CSV; a DataView of it; a DataSet's tables.
async function visualizerChecks(api, session, frameId) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const viz = api.dataVisualizer;
  const table = 'Contoso.Core.Grid.GridViewModel.GetGridMultiSelectDataTableSortableParameters(System.Linq.Enumerable.Cast<object>(System.Linq.Enumerable.Range(1, 450)))';
  const typeOf = async (expression) => {
    try {
      const r = await session.customRequest('evaluate', { expression, frameId, context: 'watch' });
      return r.type;
    } catch (e) {
      return `error: ${e.message}`;
    }
  };
  const until = async (test, ms = 60000) => {
    for (let t = 0; t < ms && !test(); t += 250) await sleep(250);
    return test();
  };
  // At Program.Main the program has not loaded these yet; the visualizer loads System.Linq and System.Data.Common itself.
  await viz.loadAssemblies(session, frameId, ['System.Data.Common', 'System.Linq', 'Contoso.Core']);
  const type = await typeOf(table);
  const when = vscode.extensions.getExtension('M455YN.csharpshooter').packageJSON.contributes.menus['debug/variables/context'].find((m) => m.command === 'csharpShooter.visualizeData').when;
  const typeTest = new RegExp(/variableType =~ \/(.*)\/$/.exec(when)[1]);
  expect('the magnifier is offered for the type the debugger reports', viz.kindOf(type) === 'DataTable' && typeTest.test(type) && !typeTest.test('System.Data.DataTableReader'), `${type}; ${when}`);

  const entry = await viz.open({ evaluateName: table, name: 'parameters', type }, session, frameId);
  if (!entry) return results;
  await until(() => entry?.said.loaded === 200);
  const first = { ...entry.said };
  expect('opens with the columns and a first page of rows, VS\'s status', first.columns?.join() === 'Value,Sort' && first.count === 450 && first.loaded === 200
    && first.first === '1|1' && first.status === 'Razem wierszy: 450', `${JSON.stringify(first)}; pages by ${entry.source.perRow ? 'row' : 'one LINQ expression'}`);
  await entry.request({ type: 'more' });
  await until(() => entry.said.loaded === 400);
  const page = await entry.source.rows(0, 400, 50);
  expect('scrolled on: the next page; any page read from the program', entry.said.loaded === 400 && page.length === 50 && page[0].cells.join() === '401,401',
    `loaded ${entry.said.loaded}, rows 401-450: ${page.length}, first ${page[0]?.cells}`);
  entry.panel.webview.postMessage({ type: 'typeFilter', text: '44' });
  await until(() => entry.said.filter === '44' && entry.said.loaded === 450);
  const filtered = { ...entry.said };
  entry.panel.webview.postMessage({ type: 'typeFilter', text: '' });
  entry.panel.webview.postMessage({ type: 'clickHeader', col: 1 });
  entry.panel.webview.postMessage({ type: 'clickHeader', col: 1 });
  await until(() => entry.said.sortDir === -1);
  expect('Filtruj fetches the rest and keeps the rows that have it; a header sorts (Malejąco)', filtered.shown === 14 && entry.said.first === '450|450',
    `filter "44": ${filtered.shown} of ${filtered.loaded}; sorted down, first: ${entry.said.first}`);
  const text = viz.csv(await entry.source.columns(0), await entry.source.rows(0, 0, 3));
  expect('CSV as VS writes it: the header, a row per line', text === 'Value,Sort\r\n1,1\r\n2,2\r\n3,3\r\n', JSON.stringify(text));
  if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-datatable.png'));
  entry.panel.dispose();

  const viewType = await typeOf(`new System.Data.DataView(${table})`);
  const view = await viz.open({ evaluateName: `new System.Data.DataView(${table})`, name: 'view', type: viewType }, session, frameId);
  await until(() => view?.said.loaded === 200);
  expect('a DataView: its rows', viz.kindOf(viewType) === 'DataView' && view.said.count === 450 && view.said.first === '1|1', `${viewType}: ${JSON.stringify(view?.said)}`);
  view?.panel.dispose();

  const setExpression = 'new System.Data.DataSet("Zestaw").Tables.Add("Pierwsza").DataSet';
  const setType = await typeOf(setExpression);
  const set = await viz.open({ evaluateName: setExpression, name: 'set', type: setType }, session, frameId);
  await until(() => set?.said.count === 0 && set.said.columns);
  const tables = await set?.source.tables();
  expect('a DataSet: its tables to choose from, an empty one said so', viz.kindOf(setType) === 'DataSet' && tables?.map((t) => t.name).join() === 'Pierwsza' && set.said.count === 0,
    `${setType}: tables ${tables?.map((t) => t.name)}, ${JSON.stringify(set?.said)}`);
  set?.panel.dispose();
  // IEnumerable, as VS's IEnumerable visualizer: a value per row, or an object's properties as columns.
  const numbers = 'System.Linq.Enumerable.ToList(System.Linq.Enumerable.Range(1, 300))';
  const numbersType = await typeOf(numbers);
  const list = await viz.open({ evaluateName: numbers, name: 'numbers', type: numbersType }, session, frameId);
  await until(() => list?.said.loaded === 200);
  expect('IEnumerable of values: one Value column, its rows a page at a time', viz.kindOf(numbersType) === 'IEnumerable' && typeTest.test(numbersType)
    && list.said.columns?.join() === 'Value' && list.said.count === 300 && list.said.first === '1', `${numbersType}: ${JSON.stringify(list?.said)}`);
  list?.panel.dispose();
  const versions = 'System.Linq.Enumerable.ToList(System.Linq.Enumerable.Select(System.Linq.Enumerable.Range(1, 3), i => new System.Version(i, 2)))';
  const objects = await viz.open({ evaluateName: versions, name: 'versions', type: await typeOf(versions) }, session, frameId);
  await until(() => objects?.said.loaded === 3);
  const versionColumns = await objects?.source.columns(0);
  const versionRows = await objects?.source.rows(0, 0, 3);
  const major = versionColumns?.findIndex((c) => c.name === 'Major');
  expect("IEnumerable of objects: a column per property, each row's values", major >= 0 && versionColumns.some((c) => c.name === 'Minor')
    && versionRows?.map((r) => r.cells[major]).join() === '1,2,3', `${versionColumns?.map((c) => `${c.name}:${c.type}`).join(', ')} | ${versionRows?.map((r) => r.cells.join('|')).join(' / ')}`);
  objects?.panel.dispose();

  // Editing a cell, as VS's DataSet visualizer: the table kept where the evaluations find it again (an expression of a call
  // would make a new one each time).
  await session.customRequest('evaluate', { expression: `System.AppDomain.CurrentDomain.SetData("csharpshooter-test", ${table})`, frameId, context: 'watch' });
  const kept = '(System.Data.DataTable)System.AppDomain.CurrentDomain.GetData("csharpshooter-test")';
  const edited = await viz.open({ evaluateName: kept, name: 'kept', type: 'System.Data.DataTable' }, session, frameId);
  await until(() => edited?.said.loaded === 200);
  await edited.request({ type: 'edit', row: 0, col: 0, value: 'zmieniony' });
  await edited.request({ type: 'edit', row: 1, col: 1, value: 'abc' });
  const refused = edited.said.editError;
  await edited.request({ type: 'edit', row: 2, col: 1, value: null });
  const after = await edited.source.rows(0, 0, 3);
  await until(() => edited.said.first === 'zmieniony|1');
  expect('a cell edited is set in the program; a value its column cannot take is refused; empty is DBNull',
    after[0].cells.join() === 'zmieniony,1' && after[1].cells.join() === '2,2' && !!refused && after[2].cells[1] === null && edited.said.first === 'zmieniony|1',
    `${after.map((r) => r.cells.join('|')).join(' / ')}; refused: ${refused}; shown first: ${edited.said.first}`);

  // Eksportuj do programu Excel...: an .xlsx, its numbers as numbers (Sort is a long column).
  const opened = process.env.CSHARPSHOOTER_NO_BROWSER;
  process.env.CSHARPSHOOTER_NO_BROWSER = '1';
  await edited.request({ type: 'xlsx' });
  if (opened === undefined) delete process.env.CSHARPSHOOTER_NO_BROWSER;
  const book = edited.said.xlsx && require('fs').readFileSync(edited.said.xlsx);
  const sheet = book?.toString('utf8') || '';
  expect('Eksportuj do programu Excel: an .xlsx of every row, numbers as numbers', book?.slice(0, 2).toString() === 'PK' && sheet.includes('xl/worksheets/sheet1.xml')
    && sheet.includes('<t xml:space="preserve">zmieniony</t>') && sheet.includes('<c><v>450</v></c>') && (sheet.match(/<row>/g) || []).length === 451,
    `${edited.said.xlsx}: ${book?.length} bytes, ${(sheet.match(/<row>/g) || []).length} rows`);
  edited.panel.dispose();
  await session.customRequest('evaluate', { expression: 'System.AppDomain.CurrentDomain.SetData("csharpshooter-test", null)', frameId, context: 'watch' });
  return results;
}

// Opublikuj, as VS publishes to a folder: a new profile written as VS writes it, dotnet publish with it, the app in its
// folder. A temporary folder and a profile removed afterwards: the project's own profiles (and where they publish) are left.
async function publishChecks(api) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const [sln] = await api.solutionView.provider.getChildren();
  const web = (await api.solutionView.provider.getChildren(sln)).find((p) => p.label === 'Contoso.Excel'); // the web projects do not publish in Release (WebApp's views' RZ2009)
  const target = fs.mkdtempSync(path.join(require('os').tmpdir(), 'csharpshooter-publish-'));
  const profiles = path.join(path.dirname(web.file), 'Properties', 'PublishProfiles');
  const before = fs.existsSync(profiles) ? fs.readdirSync(profiles) : [];
  const hadFolder = fs.existsSync(profiles);
  let made;
  try {
    const r = await vscode.commands.executeCommand('csharpShooter.solution.publish', web, { folder: target });
    made = r?.profile && path.join(profiles, `${r.profile}.pubxml`);
    const xml = made && fs.existsSync(made) ? fs.readFileSync(made, 'utf8') : '';
    expect('a new folder profile, as VS writes it, beside the project\'s own', r?.profile && !before.includes(`${r.profile}.pubxml`)
      && xml.includes(`<PublishUrl>${target}</PublishUrl>`) && xml.includes('<LastUsedBuildConfiguration>Release</LastUsedBuildConfiguration>') && xml.includes('<_TargetId>Folder</_TargetId>'),
      `${r?.profile}: ${xml.replace(/\s+/g, ' ').slice(0, 200)}`);
    const dll = fs.existsSync(path.join(target, 'Contoso.Excel.dll'));
    expect('dotnet publish with it: the app in that folder, the folder as MSBuild resolves it', r?.code === 0 && dll
      && path.resolve(r.folder).toLowerCase() === path.resolve(target).toLowerCase(), `exit ${r?.code}, folder ${r?.folder}, Contoso.Excel.dll there: ${dll}`);
  } finally {
    if (made) fs.rmSync(made, { force: true });
    if (!hadFolder && fs.existsSync(profiles) && !fs.readdirSync(profiles).length) fs.rmdirSync(profiles);
    fs.rmSync(target, { recursive: true, force: true });
  }
  // The Publish page, as VS's: a new profile from it, its settings saved to the .pubxml, Publish from it, then More
  // actions' Rename and Delete. The same library; nothing of it left afterwards.
  const pageTarget = fs.mkdtempSync(path.join(require('os').tmpdir(), 'csharpshooter-page-'));
  const hadPageFolder = fs.existsSync(profiles);
  const page = api.publishPage.open(web);
  try {
    await page.request({ type: 'new', folder: pageTarget });
    const madeName = fs.readdirSync(profiles).find((f) => f.endsWith('.pubxml') && !before.includes(f))?.replace(/\.pubxml$/, '');
    const settings = api.publishPage.readProfile(web.file, madeName);
    await page.request({ type: 'select', profile: madeName });
    await page.request({ type: 'save', settings: { ...settings, configuration: 'Debug', deleteExisting: true } });
    const saved = api.publishPage.readProfile(web.file, madeName);
    await page.request({ type: 'publish' });
    const published = api.publishPage.state.last;
    expect('the Publish page: New profile, its settings saved, Publish', saved.configuration === 'Debug' && saved.deleteExisting && published?.code === 0
      && fs.existsSync(path.join(pageTarget, 'Contoso.Excel.dll')) && path.resolve(published.folder).toLowerCase() === path.resolve(pageTarget).toLowerCase(),
      `${madeName}: ${JSON.stringify(saved)}; published: ${JSON.stringify(published)}`);
    if (process.env.SCREENSHOT) {
      await sleep(1500);
      await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-publish-page.png'));
    }
    await page.request({ type: 'rename', to: 'ShooterRenamed' });
    const renamed = fs.existsSync(path.join(profiles, 'ShooterRenamed.pubxml')) && !fs.existsSync(path.join(profiles, `${madeName}.pubxml`));
    await page.request({ type: 'delete', confirmed: true });
    const deleted = !fs.existsSync(path.join(profiles, 'ShooterRenamed.pubxml'));
    expect("More actions: Rename and Delete, the profile's file renamed and removed", renamed && deleted, `renamed: ${renamed}, deleted: ${deleted}`);
  } finally {
    page.dispose();
    for (const f of fs.existsSync(profiles) ? fs.readdirSync(profiles) : []) if (!before.includes(f)) fs.rmSync(path.join(profiles, f), { force: true });
    if (!hadPageFolder && fs.existsSync(profiles) && !fs.readdirSync(profiles).length) fs.rmdirSync(profiles);
    fs.rmSync(pageTarget, { recursive: true, force: true });
  }
  return results;
}

// The two Visual Studio 2026 themes: each one applies, as dark or light, over a C# file and the Solution Explorer.
async function themeChecks() {
  const results = [];
  const config = vscode.workspace.getConfiguration('workbench');
  const was = config.inspect('colorTheme').globalValue;
  const cs = (await vscode.workspace.findFiles('WebApp/Controllers/HomeController.cs', null, 1))[0];
  try {
    await vscode.commands.executeCommand('workbench.view.extension.csharpShooter');
    for (const [label, kind] of [['Visual Studio 2026 Light', vscode.ColorThemeKind.Light], ['Visual Studio 2026 Dark', vscode.ColorThemeKind.Dark]]) {
      await config.update('colorTheme', label, vscode.ConfigurationTarget.Global);
      for (let i = 0; i < 20 && vscode.window.activeColorTheme.kind !== kind; i++) await sleep(250);
      results.push({ name: `${label} applies`, ok: vscode.window.activeColorTheme.kind === kind, got: [String(vscode.window.activeColorTheme.kind)] });
      if (process.env.SCREENSHOT && cs) {
        await vscode.window.showTextDocument(cs);
        await sleep(5000);
        await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, `-theme-${kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light'}.png`));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    }
  } finally {
    await config.update('colorTheme', was, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  return results;
}

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
$p = Get-Process VSCodium, Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*Extension Development Host*" } | Select-Object -First 1
$r = New-Object W+RECT; [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$b = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($b); $dc = $g.GetHdc()
[W]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$b.Save('${file.replace(/'/g, "''")}')`;
  require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', script]);
}

// F5 on a launch profile, as VS runs it: listed, built, started with the profile's environment and URLs, listening.
async function launchChecks(api, profileName) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const configs = await api.launch.provider.provideDebugConfigurations();
  const wanted = `WebApp: ${profileName}`;
  expect('profiles listed in Run and Debug', configs.some((c) => c.name === wanted), configs.map((c) => c.name).join(', '));

  const { doc, pos } = await position('WebApp/Program.cs', 'CreateHostBuilder(args).Build().Run();', 0);
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(doc.uri, pos))]);
  let stopped;
  const stoppedEvent = new Promise((r) => (stopped = r));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('csharpshooter', {
    createDebugAdapterTracker: (session) => session.name !== wanted ? undefined
      : ({ onDidSendMessage: (m) => m.type === 'event' && m.event === 'stopped' && stopped({ ...m.body, session }) }),
  });
  try {
    const [sln] = await api.solutionView.provider.getChildren();
    const web = (await api.solutionView.provider.getChildren(sln)).find((p) => p.label === 'WebApp');
    const t0 = Date.now();
    if (process.env.SCREENSHOT) setTimeout(() => screenshot(process.env.SCREENSHOT.replace(/.png$/i, '-building.png')), 6000);
    const started = await vscode.commands.executeCommand('csharpShooter.solution.debugProject', web, profileName);
    const build = api.launch.state.lastBuild;
    expect('build before launch', started && build?.ok, `${build ? (build.ok ? 'build succeeded' : 'build FAILED') : 'no build'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (!started) return results;
    const body = await Promise.race([stoppedEvent, sleep(180000).then(() => null)]);
    const session = body?.session;
    expect('stops at breakpoint in Program.Main', body, body ? `stopped (${body.reason})` : 'no stop');
    if (!body) return results;
    const frame = (await session.customRequest('stackTrace', { threadId: body.threadId, levels: 1 })).stackFrames[0];
    const read = async (name) => (await session.customRequest('evaluate', { expression: `System.Environment.GetEnvironmentVariable("${name}")`, frameId: frame.id, context: 'watch' })).result;
    const environment = await read('ASPNETCORE_ENVIRONMENT');
    const urls = await read('ASPNETCORE_URLS');
    expect('profile environment applied', environment === '"Development"' && urls.includes('https://localhost:44308'), `ASPNETCORE_ENVIRONMENT=${environment}, ASPNETCORE_URLS=${urls}`);
    if (!process.env.SKIP_VISUALIZER) for (const r of await visualizerChecks(api, session, frame.id)) results.push({ ...r, name: `visualizer: ${r.name}` });
    await session.customRequest('continue', { threadId: body.threadId });
    let ended = false;
    const end = vscode.debug.onDidTerminateDebugSession((s) => s.id === session.id && (ended = true));
    for (let i = 0; i < 120 && !api.launch.state.browserUrl && !ended; i++) await sleep(1000);
    expect('app listens, browser opened at', api.launch.state.browserUrl, api.launch.state.browserUrl || (ended ? 'app ended' : 'not listening within 120 s'));
    // What the notification at the bottom right said, in order: the build's stages, the start, the wait, the browser.
    const said = api.launch.state.lastProgress?.lines || [];
    const steps = ['Kompilacja rozpoczęta', 'Kompilowanie WebApp', 'WebApp — skompilowano', 'Kompilacja zakończyła się powodzeniem', 'Odczytywanie właściwości projektu',
      'Uruchamianie z debugerem', 'Czekanie, aż aplikacja zacznie nasłuchiwać (https://localhost:44308', 'Otwieranie przeglądarki'];
    const at = steps.map((s) => said.findIndex((l) => l.startsWith(s)));
    expect('bottom right: what the build and the start are doing', at.every((i, n) => i >= 0 && (n === 0 || i >= at[n - 1])),
      [...new Set(said)].join(' | '));
    if (!ended) await vscode.debug.stopDebugging(session);
    // Ended before the next check starts one of its own.
    for (let i = 0; i < 30 && !ended; i++) await sleep(1000);
    end.dispose();
  } finally {
    tracker.dispose();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  }
  return results;
}

async function run() {
  const ext = vscode.extensions.getExtension('M455YN.csharpshooter');
  const api = await ext.activate();
  const t0 = Date.now();
  if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-loading.png'));
  await Promise.race([api.whenReady(), sleep(300000)]);
  const lines = [`projects loaded after ${((Date.now() - t0) / 1000).toFixed(1)} s`];
  // What the bottom right said while the server started and loaded the solution, and that it closed once loaded.
  for (let i = 0; i < 20 && !api.loading()?.done; i++) await sleep(250);
  const said = api.loading()?.lines || [];
  const loadingOk = api.loading()?.done && said.some((l) => l.startsWith('Uruchamianie serwera C#')) && said.some((l) => /^Wczytywanie rozwiązania WebApp \(5 projektów\)… \d+ s$/.test(l))
    && /^Rozwiązanie WebApp wczytane w \d+ s/.test(said[said.length - 1]);
  lines.push(`${loadingOk ? 'PASS' : 'FAIL'}  loading: the bottom right says it until the projects are loaded: ${[...new Set(said.map((l) => l.replace(/\d+ s$/, 'N s')))].join(' | ')}`);
  let failedLoading = loadingOk ? 0 : 1;
  // The side bar opened on the Solution Explorer, the workspace having a solution.
  const shown = api.solutionView.view.visible;
  lines.push(`${shown ? 'PASS' : 'FAIL'}  startup: the Solution Explorer is what the side bar shows: visible ${shown}`);
  failedLoading += shown ? 0 : 1;
  const checks = process.env.CHECKS_FILE ? JSON.parse(fs.readFileSync(process.env.CHECKS_FILE, 'utf8')) : { checks: defaultChecks, debug: defaultDebug };
  let failed = failedLoading;
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
  if (checks.razorTyping || (!process.env.CHECKS_FILE && process.env.SKIP_RAZOR_TYPING !== '1')) {
    for (const r of await razorTypingChecks()) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  razor typing: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.themes || (!process.env.CHECKS_FILE && process.env.SKIP_THEMES !== '1')) {
    for (const r of await themeChecks()) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  themes: ${r.name}: ${r.got.join('; ')}`);
    }
  }
  if (checks.publish || (!process.env.CHECKS_FILE && process.env.SKIP_PUBLISH !== '1')) {
    for (const r of await publishChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  publish: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.everywhere || (!process.env.CHECKS_FILE && process.env.SKIP_EVERYWHERE !== '1')) {
    for (const r of await searchEverywhereChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  search everywhere: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.search || (!process.env.CHECKS_FILE && process.env.SKIP_SEARCH !== '1')) {
    for (const r of await searchChecks(api, ext)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  search: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.launchProfile || (!process.env.CHECKS_FILE && process.env.SKIP_LAUNCH !== '1')) {
    for (const r of await launchChecks(api, checks.launchProfile || 'WebApp Development')) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  F5: ${r.name}: ${r.got.join('; ').slice(0, 200)}`);
    }
  }
  if (checks.runViewProbe) await runViewProbe();
  if (checks.startup) {
    for (const r of await startupChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  startup: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.launchJson) {
    for (const r of await launchJsonChecks()) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  launch.json: ${r.name}: ${r.got.join('; ').slice(0, 260)}`);
    }
  }
  if (checks.autorun) {
    for (const r of await autorunChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  autorun: ${r.name}: ${r.got.join('; ').slice(0, 220)}`);
    }
  }
  if (checks.taskRunner || (!process.env.CHECKS_FILE && process.env.SKIP_TASK_RUNNER !== '1')) {
    for (const r of await taskRunnerChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  task runner: ${r.name}: ${r.got.join('; ').slice(0, 200)}`);
    }
  }
  if (checks.microsoft || (!process.env.CHECKS_FILE && process.env.SKIP_MICROSOFT !== '1')) {
    for (const m of microsoftConfigs.filter((c) => !process.env.ONLY_DOTNET || c.config.type === 'dotnet')) {
      const r = await debugCheck(m);
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  F5 on ${m.label}: ${r.got.join('; ')}`);
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
