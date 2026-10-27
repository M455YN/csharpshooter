// Checks run in the editor against the workspace's solution. Each check names a file, a place found by a needle on its
// line, and what has to come back. CHECKS_FILE (JSON) replaces the defaults, written for a sample ASP.NET Core MVC solution.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const defaultChecks = [
  { name: 'C#: F12 on a method (.cs)', file: 'Contoso.Core/Authorization/AppUser.cs', needle: 'RightsChecker.CheckRightsExpr(conditions, __GetModules', off: 20, kind: 'definition', expect: 'RightsChecker.cs' },
  { name: 'C#: a NuGet package\'s type has its semantic token', file: 'Contoso.Core/Authorization/AppUser.cs', needle: 'protected SqlConnection _sqlConnection;', off: 10, kind: 'semantic', expect: 'class' },
  { name: 'C#: a field has its semantic token', file: 'Contoso.Core/Authorization/AppUser.cs', needle: 'protected SqlConnection _sqlConnection;', off: 25, kind: 'semantic', expect: 'field' },
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
  if (check.kind === 'semantic') {
    // The semantic token at the position: its type and modifiers, as the theme's semanticTokenColors sees them.
    const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', doc.uri);
    const tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', doc.uri);
    if (!legend || !tokens) return [];
    const d = tokens.data;
    for (let i = 0, line = 0, ch = 0; i < d.length; i += 5) {
      line += d[i];
      ch = d[i] ? d[i + 1] : ch + d[i + 1];
      if (line === pos.line && ch <= pos.character && pos.character < ch + d[i + 2]) {
        const mods = legend.tokenModifiers.filter((m, b) => d[i + 4] & (1 << b));
        return [[legend.tokenTypes[d[i + 3]], ...mods].join('.')];
      }
    }
    return [`no token at ${pos.line + 1}:${pos.character + 1}`];
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
  const [tasksGroup] = await runner.getChildren(sb);
  const taskRows = await runner.getChildren(tasksGroup);
  const tasks = taskRows.map(label);
  expect('tasks, as gulp lists them', ['beforeBuild', 'watchFiles_WebApp', 'minAllControlsSiteJS'].every((t) => tasks.includes(t)), tasks.join(', '));
  const bindings = runner.bindingEvents(sb.file);
  const shown = bindings.map((b) => `${label(b)}: ${b.tasks.join(', ')}`);
  expect('bindings from the /// <binding> line', shown.includes('Przed kompilacją (1): beforeBuild') && shown.includes('Otwarcie projektu (1): watchFiles_WebApp'), shown.join(' | '));

  const marks = taskRows.filter((r) => / b:/.test(r.contextValue)).map((r) => `${label(r)} [${r.contextValue.split(' ').slice(1).join(' ')}]`);
  expect('a task shows the events it is bound to (the Bindings menu checks them)',
    marks.includes('beforeBuild [b:BeforeBuild]') && marks.includes('watchFiles_WebApp [b:ProjectOpened]'), marks.join(', '));

  // As VS registers its tool window: in the bottom panel, the tree and the Bindings/console tabs side by side.
  const contributes = vscode.extensions.all.find((e) => e.extensionPath.toLowerCase() === api.extensionPath.toLowerCase())?.packageJSON.contributes;
  const inPanel = !!contributes?.viewsContainers.panel.some((c) => c.id === 'csharpShooterTaskRunner')
    && contributes.views.csharpShooterTaskRunner.map((v) => v.id).join() === 'csharpShooter.taskRunner,csharpShooter.taskRunnerConsole';
  await vscode.commands.executeCommand('csharpShooter.taskRunner.focus');
  await sleep(500);
  expect('in the bottom panel, as VS docks it', inPanel && api.taskRunner.view.visible, `panel container ${inPanel ? 'yes' : 'NO'}, tree visible ${api.taskRunner.view.visible}`);

  // Project Open: started as the workspace opened.
  for (let i = 0; i < 20 && runner.running.size < 3; i++) await sleep(500);
  const watching = [...runner.running.keys()].map((k) => k.split('|')[1]);
  // As VS runs them: cmd.exe /c gulp -b "<folder>" --color --gulpfile "<gulpfile>" <task>, node_modules\.bin first on PATH.
  const tab = [...runner.consoles.values()].find((c) => c.task === 'watchFiles_WebApp');
  const pathValue = tab && Object.entries(tab.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1];
  const binDir = path.join(path.dirname(sb.file), 'node_modules', '.bin');
  const vsLine = `cmd.exe /c gulp -b "${path.dirname(sb.file)}" --color --gulpfile "${sb.file.split(path.sep).join('/')}" watchFiles_WebApp`;
  expect("runs VS's command line, node_modules\\.bin first on PATH", tab?.commandLine === vsLine && pathValue?.startsWith(binDir),
    tab ? `${tab.commandLine}; PATH starts ${pathValue?.slice(0, binDir.length)}` : 'no console');
  expect('Project Open bindings started with the workspace', ['watchFiles_WebApp', 'watchFiles_ContosoCore', 'watchFiles_ContosoLobby'].every((w) => watching.includes(w)), watching.join(', '));
  const plain = () => (tab?.text || '').replace(/\x1b\[[\d;]*m/g, '');
  for (let i = 0; i < 40 && !plain().includes("Starting 'watchFiles_WebApp'"); i++) await sleep(500);
  const tabs = runner.tabs.state().tabs;
  expect('a running task has a console tab with its output, as VS\'s "(uruchomione)" tab',
    tabs.find((t) => t.key === tab?.key)?.title === 'watchFiles_WebApp (uruchomione)' && plain().startsWith(`${path.dirname(sb.file)}> cmd.exe /c gulp`) && plain().includes("Starting 'watchFiles_WebApp'"),
    `tabs: ${tabs.map((t) => t.title).join(' | ')}; ${JSON.stringify(plain().split(/\r?\n/).slice(0, 3))}`);
  if (process.env.SCREENSHOT) {
    runner.tabs.select(tab.key);
    await sleep(1000);
    await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-task-runner.png'));
  }
  // An error in a file the watcher minifies ends gulp (exit code 1, as in VS); Project Open starts it again, its tab
  // keeping the error. The file and what the watcher writes from it put back afterwards.
  const controls = path.join(path.dirname(sb.file), 'wwwroot', 'app', 'js', 'controls');
  const watched = fs.existsSync(controls) && fs.readdirSync(controls).find((f) => f.endsWith('.js'));
  if (watched && tab) {
    const source = path.join(controls, watched);
    const minified = path.join(controls, 'minifiedControls', watched.replace(/\.js$/, '.min.js'));
    const saved = [source, minified].filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f)]);
    const live = () => (runner.consoles.get(tab.key)?.text || '').replace(/\x1b\[[\d;]*m/g, ''); // a run again has a tab of its own
    const starts = () => live().split("Starting 'watchFiles_WebApp'").length - 1;
    try {
      await sleep(11000); // past the first seconds, in which a failing start is not tried again
      fs.appendFileSync(source, '\nlet s s;\n');
      for (let i = 0; i < 120 && starts() < 2; i++) await sleep(500);
      const text = live();
      expect('a watcher ended by an error in a file it watches starts again (Project Open), its tab keeping the error',
        text.includes('SyntaxError in plugin') && /exit code 1|kodem zakończenia 1/.test(text) && starts() >= 2 && runner.running.has(tab.key),
        `starts ${starts()}, running ${runner.running.has(tab.key)}: ${JSON.stringify(text.split(/\r?\n/).filter((l) => /SyntaxError|exit|zakończ|Starting/.test(l)).slice(-5))}`);
    } finally {
      for (const [f, data] of saved) fs.writeFileSync(f, data);
      await sleep(5000); // the watcher minifies the restored file: what it wrote is put back too
      for (const [f, data] of saved) fs.writeFileSync(f, data);
      if (!saved.some(([f]) => f === minified)) fs.rmSync(minified, { force: true });
    }
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
      const event = runner.bindingEvents(lobbyNode.file).find((b) => b.binding === 'AfterBuild');
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

  // Before Build, as a build of WebApp runs it when buildBindings is on. What it writes (wwwroot's css and minified js,
  // from sources that may have changed since they were last built) is put back afterwards.
  const config = vscode.workspace.getConfiguration('csharpShooter.taskRunner');
  await config.update('buildBindings', true, vscode.ConfigurationTarget.Global);
  const wwwroot = path.join(path.dirname(sb.file), 'wwwroot');
  const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
  const built = new Map(filesIn(wwwroot).map((f) => [f, fs.readFileSync(f)]));
  try {
    const { buildBindings } = api.taskRunner; // the running extension's (dist/extension.js), not a second copy of the module
    const t0 = Date.now();
    const ok = await buildBindings('BeforeBuild', path.dirname(sb.file));
    expect('a run ends saying its exit code', runner.lastExit?.task === 'beforeBuild' && runner.lastExit.code === 0,
      `Zadanie ${runner.lastExit?.task} zakończone z kodem zakończenia ${runner.lastExit?.code}`);
    expect('Before Build binding runs before a build', ok, `gulp beforeBuild ${ok ? 'succeeded' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } finally {
    await config.update('buildBindings', undefined, vscode.ConfigurationTarget.Global);
    for (const f of filesIn(wwwroot)) if (!built.has(f)) fs.rmSync(f, { force: true });
    for (const [f, data] of built) if (Buffer.compare(data, fs.readFileSync(f)) !== 0) fs.writeFileSync(f, data);
  }
  return results;
}

// With tasks.json's runOn: folderOpen watchers started by the editor: Project Open's runs win, each watcher runs once,
// in the Task Runner with its output; a tasks.json run started by hand has a tab, and is taken over from there.
async function autorunChecks(api) {
  const { runner } = api.taskRunner;
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const watchers = ['watchFiles_WebApp', 'watchFiles_ContosoCore', 'watchFiles_ContosoLobby'];
  const runsOf = (w) => vscode.tasks.taskExecutions.filter((e) => e.task.name.includes(w));
  const plain = (w) => ([...runner.consoles.values()].find((c) => c.task === w && c.running)?.text || '').replace(/\x1b\[[\d;]*m/g, '');
  for (let i = 0; i < 60 && !watchers.every((w) => plain(w).includes(`Starting '${w}'`)); i++) await sleep(500);
  await sleep(5000); // and a moment more, for any second run to show
  const counts = watchers.map((w) => `${w}: ${runsOf(w).map((e) => e.task.name).join(' + ') || 'none'}`);
  expect("each watcher runs once, the Task Runner's with its output (tasks.json's stopped)",
    watchers.every((w) => runsOf(w).length === 1 && !runsOf(w)[0].task.name.includes('[Autorun]') && plain(w).includes(`Starting '${w}'`)), `${counts.join(' | ')}; ${runner.said.join(' / ')}`);
  const rows = [];
  for (const f of (await runner.getChildren()).filter((n) => n.kind === 'gulpfile')) {
    const [tasksGroup] = await runner.getChildren(f);
    rows.push(...(await runner.getChildren(tasksGroup)).filter((r) => watchers.includes(r.task)));
  }
  expect('the Task Runner shows them running', rows.length === 3 && rows.every((r) => r.contextValue.startsWith('trTask.running')),
    rows.map((r) => `${r.task}: ${r.description || 'idle'}`).join(', '));

  // tasks.json's task run by hand: its tab says its output is in its terminal; taken over, it runs here with its output.
  const taken = rows.find((r) => r.task === 'watchFiles_WebApp');
  const key = `${taken.file}|${taken.task}`;
  runner.stop(taken.file, taken.task);
  for (let i = 0; i < 30 && runsOf('watchFiles_WebApp').length; i++) await sleep(500);
  const own = (await vscode.tasks.fetchTasks()).find((t) => t.name.includes('watchFiles_WebApp') && t.source === 'Workspace');
  if (own) await vscode.tasks.executeTask(own);
  for (let i = 0; i < 20 && !runner.tabs.state().tabs.some((t) => t.key === key && t.external); i++) await sleep(500);
  const external = runner.tabs.state().tabs.find((t) => t.key === key)?.external;
  runner.takeOver(key);
  for (let i = 0; i < 60 && !plain('watchFiles_WebApp').includes("Starting 'watchFiles_WebApp'"); i++) await sleep(500);
  expect("a tasks.json run by hand has a tab; taken over, its output shows here", !!external && plain('watchFiles_WebApp').includes("Starting 'watchFiles_WebApp'") && runsOf('watchFiles_WebApp').length === 1,
    `tab: ${external ? 'yes' : 'none'}; runs ${runsOf('watchFiles_WebApp').map((e) => e.task.name).join(' + ')}; ${JSON.stringify(plain('watchFiles_WebApp').slice(-200))}`);
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

// launch.json with CSharpShooter's entry in it (csharpShooter.launchProfilesInLaunchJson: always): only "Projekt startowy
// (CSharpShooter)", VS's start button, the workspace's own entries kept, and it started by its name as F5 starts it.
async function launchJsonChecks() {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const configs = () => vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders[0].uri).get('configurations') || [];
  for (let i = 0; i < 40 && !configs().some((c) => c.type === 'csharpshooter'); i++) await sleep(500);
  // An entry with the earlier, Polish-only name ("Projekt startowy (CSharpShooter)") is renamed as the folder opens.
  for (let i = 0; i < 20 && configs().some((c) => c.name === 'Projekt startowy (CSharpShooter)'); i++) await sleep(500);
  const opened = configs().filter((c) => c.type === 'csharpshooter' && c.startupProject).map((c) => c.name);
  expect('the startup entry is named "CSharpShooter", in both languages (the earlier name renamed)', opened.join() === 'CSharpShooter', opened.join(' | '));
  // From a launch.json without CSharpShooter's entries (runTest.js puts the file back): only the startup entry comes.
  const folder = vscode.workspace.workspaceFolders[0];
  await vscode.workspace.getConfiguration('launch', folder.uri).update('configurations', configs().filter((c) => c.type !== 'csharpshooter'), vscode.ConfigurationTarget.WorkspaceFolder);
  const added = await vscode.commands.executeCommand('csharpShooter.addLaunchProfiles');
  const names = configs().map((c) => c.name);
  expect('only the startup entry is added to launch.json (no project profiles), first, the existing entries kept after it',
    JSON.stringify(added) === '["CSharpShooter"]' && names.filter((n) => configs().find((c) => c.name === n).type === 'csharpshooter').length === 1
    && names[0] === 'CSharpShooter' && configs()[1]?.type === 'coreclr', `added ${JSON.stringify(added)}: ${names.join(' | ')}`);
  // F5 and Ctrl+F5 run it whatever Run and Debug has selected (VS Code gives an extension no way to select an entry there).
  const keys = vscode.extensions.all.find((e) => e.packageJSON.name === 'csharpshooter')?.packageJSON.contributes.keybindings || [];
  const bound = (key, command) => keys.some((k) => k.key === key && k.command === command && k.when === '!inDebugMode');
  expect('F5 and Ctrl+F5 start the startup project, as in VS', bound('f5', 'csharpShooter.startup.start') && bound('ctrl+f5', 'csharpShooter.startup.startWithoutDebugging'),
    keys.filter((k) => /^(ctrl\+)?f5$/.test(k.key)).map((k) => `${k.key}: ${k.command} (${k.when})`).join(', '));
  if (process.env.SCREENSHOT) {
    await vscode.commands.executeCommand('workbench.view.debug');
    vscode.commands.executeCommand('workbench.action.debug.selectandstart');
    await sleep(2500);
    await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-launch-json.png'));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  }
  // Started as F5 starts it; its build skipped here (build: false), so the projects' build outputs stay as they were.
  let session;
  const started = new Promise((r) => { const d = vscode.debug.onDidStartDebugSession((s) => (d.dispose(), r(s))); });
  const entry = configs().find((c) => c.name === 'CSharpShooter');
  const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], { ...entry, build: false });
  session = ok ? await Promise.race([started, sleep(240000).then(() => null)]) : null;
  expect('started as F5 starts it: the startup project with its active profile', session?.type === 'csharpshooter' && session.configuration.env?.ASPNETCORE_ENVIRONMENT === 'Development',
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
    expect('F5 on "CSharpShooter" runs the startup project with its active profile',
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

  // Zamień w plikach (Ctrl+Shift+H), on a file of the test's own, removed after: Zamień on one line, Zamień wszystko on
  // the rest, then a regular expression's group; the file is saved, not having been open.
  const scratch = path.resolve(root(), 'WebApp', 'csharpshooter-replace.txt');
  fs.writeFileSync(scratch, 'alpha beta alpha\nkeep\nalpha(1)\n');
  try {
    const only = { filter: 'text', fileTypes: 'csharpshooter-replace.txt' };
    r = await search('alpha', only);
    const hits = (r.groups.text || []).map((l) => l.line).join();
    const one = await api.searchEverywhere.replace('alpha', only, 'omega', [{ path: scratch, line: 3 }]);
    const afterOne = fs.readFileSync(scratch, 'utf8');
    r = await search('alpha', only);
    const rest = await api.searchEverywhere.replace('alpha', only, 'omega', null, true);
    const afterAll = fs.readFileSync(scratch, 'utf8');
    r = await search('(be)ta', { ...only, regex: true });
    const grouped = await api.searchEverywhere.replace('(be)ta', { ...only, regex: true }, '$1TA', null, true);
    const afterRegex = fs.readFileSync(scratch, 'utf8');
    expect('Zamień w plikach: one line, then all (saved), then a regular expression\'s $1',
      hits === '1,3' && one.replaced === 1 && afterOne === 'alpha beta alpha\nkeep\nomega(1)\n' && rest.replaced === 2 && afterAll === 'omega beta omega\nkeep\nomega(1)\n'
      && grouped.replaced === 1 && afterRegex === 'omega beTA omega\nkeep\nomega(1)\n',
      `lines ${hits}; ${one.replaced} → ${JSON.stringify(afterOne)}; ${rest.replaced} → ${JSON.stringify(afterAll)}; ${grouped.replaced} → ${JSON.stringify(afterRegex)}`);
    if (process.env.SCREENSHOT) {
      fs.writeFileSync(scratch, 'alpha beta alpha\nkeep\nalpha(1)\n');
      await vscode.commands.executeCommand('csharpShooter.replaceInFiles', 'alpha');
      await sleep(3000);
      await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-replace.png'));
    }
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(scratch, { force: true });
  }
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

  // A collection a level down (a watch's member, as a field of a field in Variables): the magnifier reads it by the whole
  // expression, the parent's cast to its type and the member, not by the member's name alone (Passenger's evaluateName).
  const watch = await session.customRequest('evaluate', { expression: 'System.Tuple.Create(new System.Collections.Generic.List<int> { 1, 2, 3 })', frameId, context: 'watch' });
  const { variables } = await session.customRequest('variables', { variablesReference: watch.variablesReference });
  const item1 = variables.find((v) => v.name === 'Item1');
  const nested = item1 && await vscode.commands.executeCommand('csharpShooter.visualizeData', { sessionId: session.id, container: { variablesReference: watch.variablesReference }, variable: item1 });
  await until(() => nested?.said.count !== undefined, 30000);
  expect('a member a level down: opened by its whole expression', nested?.said.count === 3 && nested.source.expression.includes('System.Tuple<'),
    `Item1 (evaluateName "${item1?.evaluateName}"): ${nested?.source.expression} → ${JSON.stringify(nested?.said.count)} rows`);
  nested?.panel.dispose();
  return results;
}

// NuGet — rozwiązanie, as VS's Manage Packages for Solution: the solution's top-level and transitive packages from dotnet
// list package, those with a newer version under Updates, the vulnerable ones counted; a package's details from its
// source (licence, date published, dependencies) and its README; Browse over a local folder source; then one package
// updated in its projects through the page, as VS does it: Preview Changes, then dotnet add package in a task, tried
// again while another program holds the project file. The project files are put back and restored afterwards.
async function nugetChecks(api) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const page = await api.nugetPage.open();
  const newer = (a, b) => api.nugetPage.compareVersions(a, b) > 0;
  try {
    const opened = Date.now();
    const data = await Promise.race([page.loaded(), sleep(180000)]);
    expect("the list, its updates and vulnerabilities in seconds (the restore assets, the source's search)", data && Date.now() - opened < 10000, `${((Date.now() - opened) / 1000).toFixed(1)} s`);
    const packages = [...(data?.packages.values() || [])];
    const top = packages.filter((p) => p.projects.size);
    const installed = page.shown?.rows || [];
    expect('Installed: the top-level packages with their versions', installed.length && installed.length === top.length && installed.every((r) => r.installed),
      `${installed.length} rows: ${installed.slice(0, 6).map((r) => `${r.id} ${r.installed}${r.latest ? ` → ${r.latest}` : ''}${r.vulnerable ? ' ⚠' : ''}`).join(', ')}; ${data?.problems.join(' ') || 'no problems'}`);
    const transitive = page.shown.transitiveRows;
    expect('Installed: the transitive packages under their own group, with the versions dotnet resolved', transitive.length && transitive.every((r) => r.transitive && r.installed),
      `${transitive.length}: ${transitive.slice(0, 4).map((r) => `${r.id} ${r.installed}`).join(', ')}; banner: ${page.shown.banner}`);
    await page.request({ type: 'tab', tab: 'updates' });
    const updates = page.shown.rows;
    expect('Updates: the packages with a newer version, counted on the tab', updates.length === page.shown.updates && updates.every((r) => r.latest && r.update),
      `${page.shown.updates}: ${updates.map((r) => `${r.id} ${r.installed} → ${r.latest}`).join(', ')}`);
    // The first package with an update, at the newest version its source offers.
    const pk = updates[0] && packages.find((p) => p.id === updates[0].id);
    const latest = updates[0]?.latest;
    if (pk) {
      await page.request({ type: 'select', id: pk.id });
      const d = page.shown.details;
      expect(`the pane: ${pk.id}'s licence, date published and dependencies from its source`, d?.license && d.published && Array.isArray(d.dependencies),
        `${d?.version}: licence ${d?.license?.text}, published ${d?.published}, ${d?.dependencies?.length} dependency groups, mapping: ${d?.mapping.text}`);
      await page.request({ type: 'paneTab', tab: 'readme' });
      for (const end = Date.now() + 30000; page.shown.details?.readme === undefined && Date.now() < end;) await sleep(200);
      expect('the pane: its README, rendered', page.shown.details?.readme?.includes('<'), page.shown.details?.readme?.replace(/\s+/g, ' ').slice(0, 120));
      await page.request({ type: 'paneTab', tab: 'details' });
    }
    const folder = page.shown.sources.find((s) => s.value !== '*' && !/^https?:/i.test(s.value));
    if (folder) {
      await page.request({ type: 'source', source: folder.value });
      await page.request({ type: 'tab', tab: 'browse' });
      await page.request({ type: 'search', query: 'System' });
      const found = page.shown.rows;
      expect(`Browse in a folder source (${folder.label}): its .nupkg files, read from their .nuspec`, found.length && found.every((r) => r.id && (r.latest || r.installed)),
        found.slice(0, 4).map((r) => `${r.id} ${r.latest || r.installed} ${r.authors}`).join(', '));
      await page.request({ type: 'search', query: '' });
      await page.request({ type: 'source', source: page.shown.sources.find((s) => /nuget\.org/i.test(s.value))?.value });
      await page.request({ type: 'tab', tab: 'updates' });
    }
    if (process.env.SCREENSHOT) {
      if (pk) await page.request({ type: 'select', id: pk.id });
      await sleep(2500);
      await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-nuget.png'));
    }
    if (!pk) return results;
    // In every project that has it older, as the Updates tab checks them: one project alone would downgrade it in a project
    // that references that one (NU1605), as in VS.
    const projects = [...pk.projects.values()].filter((v) => newer(latest, v.resolved));
    const before = projects.map((p) => fs.readFileSync(p.file));
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    let lock;
    try {
      await page.request({ type: 'select', id: pk.id });
      await page.request({ type: 'check', files: page.shown.details.projects.map((p) => p.file), value: false });
      await page.request({ type: 'check', files: page.shown.details.projects.filter((p) => projects.some((x) => same(x.file, p.file))).map((p) => p.file), value: true });
      page.dialog = undefined;
      await page.request({ type: 'install', version: latest });
      const preview = page.dialog;
      if (process.env.SCREENSHOT) {
        await sleep(1500);
        await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-nuget-preview.png'));
      }
      const lines = (preview?.preview || []).flatMap((p) => p.sections.flatMap((s) => s.items.map((i) => `${p.name}: ${s.label} ${i}`)));
      expect('Preview Changes first, as VS lists them', preview?.title === 'Podgląd zmian' && lines.length === projects.length && lines.every((l) => l.includes(`do ${pk.id} wersji ${latest}`)), lines.join('; ') || `no dialog: ${page.shown.status?.text}; checked ${JSON.stringify(page.shown.details?.projects.map((p) => [p.name, p.checked, p.version]))}`);
      if (!preview) return results;
      // Another program holds the first project file a moment: dotnet add fails on it, and the page runs it again.
      lock = require('child_process').spawn('powershell', ['-NoProfile', '-Command',
        `$f = [IO.File]::Open('${projects[0].file}', 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Milliseconds 1500; $f.Close()`]);
      await new Promise((resolve) => lock.stdout.once('data', resolve));
      await page.request(preview.buttons[0].answer);
      const written = projects.every((p) => fs.readFileSync(p.file, 'utf8').includes(latest));
      const now = page.shown.details.projects.filter((p) => projects.some((x) => same(x.file, p.file))).map((p) => p.version);
      expect(`Update: ${pk.id} → ${latest} in ${projects.map((p) => path.basename(p.file)).join(', ')}, by dotnet add package`,
        page.state.last?.codes.every((c) => c === 0) && written && now.every((v) => v === latest) && !page.shown.status?.error,
        `exit ${page.state.last?.codes.join()}, the project files have ${latest}: ${written}, the page shows ${now.join()}; ${page.shown.status?.text}`);
      expect('a project file another program held: dotnet add run again', page.state.last?.attempts[0] > 1, `attempts ${page.state.last?.attempts.join()}`);
    } finally {
      lock?.kill();
      projects.forEach((p, i) => fs.writeFileSync(p.file, before[i]));
      await new Promise((resolve) => require('child_process').execFile('dotnet', ['restore', api.nugetPage.pages.keys().next().value], { windowsHide: true }, resolve));
    }
  } finally {
    page.dispose();
  }
  return results;
}

// Opublikuj, as VS publishes to a folder: a new profile written as VS writes it, dotnet publish with it, the app in its
// folder. A temporary folder and a profile removed afterwards: the project's own profiles (and where they publish) are left.
// The project Properties page, as VS 2026's: the rules' pages in Polish, values from the project file and MSBuild, a
// property shown or hidden by its condition, and changes written to the project file as VS writes them (a plain one, one of
// the Debug configuration's, DefineConstants through VS's interceptor), read back from MSBuild; the project file left as it
// was, byte for byte.
async function propertiesChecks(api) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const [sln] = await api.solutionView.provider.getChildren();
  const lib = (await api.solutionView.provider.getChildren(sln)).find((p) => p.label === 'Contoso.Excel');
  const before = fs.readFileSync(lib.file);
  const panel = await vscode.commands.executeCommand('csharpShooter.solution.properties', lib);
  const until = async (test, ms = 60000) => {
    for (let t = 0; t < ms && !test(); t += 250) await sleep(250);
    return test();
  };
  try {
    await until(() => panel.state.model);
    const all = () => panel.state.model.flatMap((p) => p.categories.flatMap((c) => c.properties));
    const prop = (id) => all().find((p) => p.id === id);
    const titles = panel.state.model.map((p) => p.title);
    const outputType = prop('Application::OutputType');
    const tfm = prop('Application::InterceptedTargetFramework');
    expect("pages and values: VS's Polish pages, Typ danych wyjściowych and Struktura docelowa from MSBuild",
      titles.join() === 'Aplikacja,Użycie globalne,Kompilacja,Pakiet,Analiza kodu,Debuguj,Zasoby' && outputType?.value === 'Library'
      && outputType.choices.find((c) => c.value === 'Library')?.label === 'Biblioteka klas' && String(tfm?.value).startsWith('.NETCoreApp,Version=v')
      && tfm.choices.find((c) => c.value === tfm.value)?.label.startsWith('.NET '),
      `${titles.join(', ')} | ${outputType?.value} | ${tfm?.value} (${tfm?.choices.find((c) => c.value === tfm.value)?.label})`);
    expect('VisibilityCondition: Docelowe struktury hidden for one framework, Docelowy system operacyjny shown for .NET 5+',
      !prop('Application::TargetFrameworks') && prop('Application::TargetPlatformIdentifier') && !prop('Application::TargetPlatformVersion') && tfm.searchTerms === 'TFM',
      `TargetFrameworks ${!!prop('Application::TargetFrameworks')}, TargetPlatformIdentifier ${!!prop('Application::TargetPlatformIdentifier')}`);

    const seq = () => panel.state.model;
    let was = seq();
    await panel.request({ type: 'set', id: 'Application::AssemblyTitle', value: 'Shooter Title' });
    await until(() => seq() !== was);
    const titled = fs.readFileSync(lib.file, 'utf8');
    expect('a plain property: written to the project file, read back', titled.includes('<AssemblyTitle>Shooter Title</AssemblyTitle>') && prop('Application::AssemblyTitle')?.value === 'Shooter Title',
      prop('Application::AssemblyTitle')?.value);

    was = seq();
    await panel.request({ type: 'set', id: 'Build::Optimize', value: true });
    await until(() => seq() !== was);
    was = seq();
    await panel.request({ type: 'set', id: 'Build::DefineConstants', value: 'SHOOTER' });
    await until(() => seq() !== was);
    const debug = fs.readFileSync(lib.file, 'utf8');
    const open = debug.indexOf(`<PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|AnyCPU'">`);
    const group = open < 0 ? '' : debug.slice(open, debug.indexOf('</PropertyGroup>', open));
    expect("the Debug configuration's: Optimize and DefineConstants in its group, DefineConstants on top of what it inherits",
      group.includes('<Optimize>true</Optimize>') && group.includes('<DefineConstants>$(DefineConstants);SHOOTER</DefineConstants>')
      && prop('Build::Optimize')?.value === true && prop('Build::DefineConstants')?.value === 'SHOOTER' && panel.state.evaluated.properties.DefineConstants.split(';').includes('SHOOTER'),
      `group: ${group.split(/\s+/).join(' ').trim()} | evaluated ${panel.state.evaluated.properties.DefineConstants}`);
    if (process.env.SCREENSHOT) {
      await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-properties.png'));
      panel.webview.postMessage({ type: 'search', text: 'TFM' });
      await sleep(1000);
      await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-properties-search.png'));
    }
  } finally {
    panel.dispose();
    fs.writeFileSync(lib.file, before);
  }
  expect('the project file put back as it was', Buffer.compare(before, fs.readFileSync(lib.file)) === 0, 'byte for byte');
  return results;
}

// Menedżer konfiguracji, as VS's: each project's context for the active solution configuration, a change to one written
// to the solution as VS writes it, a new solution configuration with new project configurations (in each project file,
// its Debug groups copied), renamed and removed through Edytuj; the solution and every project file left as they were.
async function configurationManagerChecks(api) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const config = require(path.join(process.env.CSHARPSHOOTER_SOURCES, 'solution-config'));
  const startup = api.startup.startup;
  const settings = await startup.solutionSettings();
  const files = [settings.solution, ...config.read(settings.solution).projects.map((p) => p.file)];
  const before = new Map(files.map((f) => [f, fs.readFileSync(f)]));
  const panel = await api.configurationManager.open();
  const until = async (test, ms = 60000) => {
    for (let t = 0; t < ms && !test(); t += 250) await sleep(250);
    return test();
  };
  const lib = () => config.read(settings.solution).projects.find((p) => path.basename(p.file, path.extname(p.file)) === 'Contoso.Excel');
  try {
    await until(() => panel.state);
    const rows = panel.state.model.projects;
    expect("the solution's projects, the status bar's configuration and platform", panel.title === 'Menedżer konfiguracji' && rows.length === files.length - 1
      && panel.state.settings.configuration === settings.configuration && panel.state.settings.platform === settings.platform,
      `${panel.title}: ${rows.map((p) => p.path).join(', ')} | ${panel.state.settings.configuration}|${panel.state.settings.platform}`);

    const k = config.key(settings.configuration, settings.platform);
    await panel.request({ type: 'cell', project: lib().path, change: { build: false } });
    const off = lib().cells.get(k);
    const text = fs.readFileSync(settings.solution, 'utf8');
    expect("Kompilacja off for one project: in the solution as VS writes it", off.build === false
      && (/\.slnx$/i.test(settings.solution) ? text.includes(`<Build Solution="${settings.configuration}|${settings.platform}" Project="false" />`)
        : !text.includes(`{${lib().guid}}.${settings.configuration}|${settings.platform}.Build.0`)),
      `${JSON.stringify(off)} | ${text.split(/\r?\n/).filter((l) => /<Build |Build\.0/.test(l)).slice(0, 4).join(' ')}`);
    await panel.request({ type: 'cell', project: lib().path, change: { build: true } });
    expect('and on again: the solution as it was', Buffer.compare(before.get(settings.solution), fs.readFileSync(settings.solution)) === 0, 'byte for byte');

    await panel.request({ type: 'newSolution', kind: 'buildTypes', name: 'Shooter Test', from: 'Debug', create: true });
    const added = config.read(settings.solution);
    const projectText = fs.readFileSync(lib().file, 'utf8');
    const mapped = await startup.buildSettings(lib().file);
    expect('<Nowy...>: a solution configuration, each project its own of that name (Debug\'s groups copied), and the active one',
      added.buildTypes.includes('Shooter Test') && /<Configurations>[^<]*Shooter Test[^<]*<\/Configurations>/.test(projectText)
      && (!projectText.includes("=='Debug|AnyCPU'") || projectText.includes("=='Shooter Test|AnyCPU'"))
      && (await startup.solutionSettings()).configuration === 'Shooter Test' && mapped.configuration === 'Shooter Test',
      `${added.buildTypes.join(', ')} | ${/<Configurations>([^<]*)/.exec(projectText)?.[1]} | builds as ${mapped.configuration}|${mapped.platform}`);
    const msbuild = require('child_process').execFileSync('dotnet', ['msbuild', lib().file, '-getProperty:Configurations'], { encoding: 'utf8' }).trim();
    expect('MSBuild reads the project\'s new configuration', msbuild.includes('Shooter Test'), msbuild);

    await panel.request({ type: 'edit', kind: 'buildTypes', op: 'rename', name: 'Shooter Test', to: 'Shooter Renamed' });
    const renamed = config.read(settings.solution);
    await panel.request({ type: 'edit', kind: 'buildTypes', op: 'remove', name: 'Shooter Renamed' });
    const removed = config.read(settings.solution);
    expect('<Edytuj...>: renamed, then removed', renamed.buildTypes.includes('Shooter Renamed') && !renamed.buildTypes.includes('Shooter Test')
      && !removed.buildTypes.includes('Shooter Renamed') && Buffer.compare(before.get(settings.solution), fs.readFileSync(settings.solution)) === 0,
      `${renamed.buildTypes.join(', ')} -> ${removed.buildTypes.join(', ')}`);
    if (process.env.SCREENSHOT) {
      await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-configuration-manager.png'));
    }
  } finally {
    panel.dispose();
    for (const [f, data] of before) require(path.join(process.env.CSHARPSHOOTER_SOURCES, 'write-file')).writeFileWhenFree(f, data, 200);
    await startup.setSolutionSettings({ configuration: settings.configuration, platform: settings.platform });
  }
  expect('the solution and its project files put back as they were', [...before].every(([f, data]) => Buffer.compare(data, fs.readFileSync(f)) === 0), `${before.size} files`);
  return results;
}

// The Properties window (F4), as VS's: a file's Akcja kompilacji, Kopiuj do katalogu wyjściowego and the rest in Polish,
// a change written to the project file as VS writes it (an Update; a Remove with an Include) and read back from MSBuild,
// a folder's and a project's own rows. A file made for it, removed afterwards; the project file left as it was.
async function propertiesWindowChecks(api) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const [sln] = await api.solutionView.provider.getChildren();
  const lib = (await api.solutionView.provider.getChildren(sln)).find((p) => p.label === 'Contoso.Excel');
  const before = fs.readFileSync(lib.file);
  const file = path.join(path.dirname(lib.file), 'shooter-properties.txt');
  const win = api.propertiesWindow;
  const pick = (kind, f) => win.select({ contextValue: kind, file: kind === 'project' ? f : undefined, resourceUri: vscode.Uri.file(f) });
  const row = (name) => win.state.sheet?.rows.find((r) => r.name === name);
  fs.writeFileSync(file, 'shooter');
  try {
    await vscode.commands.executeCommand('csharpShooter.propertiesWindow.focus');
    await pick('file', file);
    const titles = win.state.sheet?.rows.map((r) => r.title).join(', ');
    const action = row('{}{ItemType}');
    expect("a file: VS's rows in Polish, Akcja kompilacji Brak (the SDK's None glob), Nie kopiuj, its name and path",
      action?.value === 'None' && action.choices.find((c) => c.value === 'None')?.label === 'Brak' && row('CopyToOutputDirectory')?.value === 'Never'
      && row('FileNameAndExtension')?.value === 'shooter-properties.txt' && row('FullPath')?.readOnly && titles.includes('Narzędzie niestandardowe'),
      `${titles} | ${action?.value} | ${row('CopyToOutputDirectory')?.value}`);
    if (process.env.SCREENSHOT) await screenshot(process.env.SCREENSHOT.replace(/\.png$/i, '-properties-window.png'));

    await win.set('CopyToOutputDirectory', 'PreserveNewest');
    let text = fs.readFileSync(lib.file, 'utf8');
    expect('Kopiuj, jeśli nowszy: an Update in the project file, read back from MSBuild', /<None Update="shooter-properties\.txt">\s*<CopyToOutputDirectory>PreserveNewest<\/CopyToOutputDirectory>\s*<\/None>/.test(text)
      && row('CopyToOutputDirectory')?.value === 'PreserveNewest', `${row('CopyToOutputDirectory')?.value}`);
    await win.set('{}{ItemType}', 'Content');
    text = fs.readFileSync(lib.file, 'utf8');
    expect('Akcja kompilacji Zawartość: None Remove, Content Include with its metadata, read back',
      text.includes('<None Remove="shooter-properties.txt" />') && /<Content Include="shooter-properties\.txt">\s*<CopyToOutputDirectory>PreserveNewest/.test(text)
      && row('{}{ItemType}')?.value === 'Content' && row('CopyToOutputDirectory')?.value === 'PreserveNewest', `${row('{}{ItemType}')?.value} ${row('CopyToOutputDirectory')?.value}`);
    await win.set('{}{ItemType}', 'None');
    await win.set('CopyToOutputDirectory', '');
    expect('and back: the project file as it was', Buffer.compare(before, fs.readFileSync(lib.file)) === 0 && row('{}{ItemType}')?.value === 'None', 'byte for byte');

    await pick('folder', path.dirname(file));
    const folder = win.state.sheet?.rows.map((r) => `${r.title}=${r.value}`).join(', ');
    await pick('project', lib.file);
    const project = win.state.sheet?.rows.map((r) => `${r.title}=${r.value}`).join(', ');
    expect("a folder's and a project's rows", folder?.startsWith('Nazwa folderu=') && project?.startsWith(`Nazwa pliku=${path.basename(lib.file)}, Folder projektu=`), `${folder} | ${project}`);
  } finally {
    require(path.join(process.env.CSHARPSHOOTER_SOURCES, 'write-file')).writeFileWhenFree(lib.file, before, 200);
    fs.rmSync(file, { force: true });
  }
  expect('the project file put back as it was', Buffer.compare(before, fs.readFileSync(lib.file)) === 0, 'byte for byte');
  return results;
}

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
  // Roslyn's own token types (field, extensionMethod, recordClass…) are coloured by a theme that knows only VS Code's
  // (VSCodium's Dark 2026) through their supertypes, and by ours through a colour or a supertype.
  if (cs) {
    const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', (await vscode.workspace.openTextDocument(cs)).uri);
    const declared = Object.fromEntries(vscode.extensions.getExtension('M455YN.csharpshooter').packageJSON.contributes.semanticTokenTypes.map((t) => [t.id, t.superType]));
    const ours = JSON.parse(fs.readFileSync(path.join(vscode.extensions.getExtension('M455YN.csharpshooter').extensionPath, 'themes', 'visual-studio-2026-dark-color-theme.json'), 'utf8')).semanticTokenColors;
    const wanted = ['field', 'extensionMethod', 'constant', 'recordClass', 'recordStruct', 'delegate', 'controlKeyword'];
    const missing = wanted.filter((t) => !legend?.tokenTypes.includes(t) || !declared[t] || !(ours[t] || ours[declared[t]]));
    results.push({ name: 'Roslyn\'s own token types have a supertype and a colour', ok: missing.length === 0, got: missing.length ? [`missing ${missing.join(', ')}`, `legend ${legend?.tokenTypes.length}`] : [wanted.map((t) => `${t}→${declared[t]}`).join(', ')] });
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

// F5 with nothing changed starts with no build, as Passenger 0.2.1 does: Ctrl+F5 once (building or not), again (up to
// date, its properties not read again), and after a source file's time changes (built); then once more while a dotnet build
// of it runs in a task of its own, which it waits out.
async function upToDateChecks(api, projectPath) {
  const results = [];
  const expect = (name, ok, got) => results.push({ name, ok: !!ok, got: [String(got)] });
  const folder = vscode.workspace.workspaceFolders[0];
  const project = path.join(folder.uri.fsPath, projectPath);
  const config = { type: 'csharpshooter', request: 'launch', name: `${path.basename(project, '.csproj')}: up to date`, project, launchProfile: null, launchBrowser: false };
  const ended = (execution) => new Promise((res) => { const d = vscode.tasks.onDidEndTask((e) => e.execution === execution && (d.dispose(), res())); });
  const start = async () => {
    api.launch.state.lastBuild = undefined;
    const t0 = Date.now();
    await vscode.debug.startDebugging(folder, config, { noDebug: true });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const run = api.launch.state.lastRunWithoutDebugging;
    if (run && vscode.tasks.taskExecutions.includes(run.execution)) {
      const end = ended(run.execution);
      run.execution.terminate();
      await Promise.race([end, sleep(30000)]);
    }
    return { build: api.launch.state.lastBuild, lines: [...new Set(api.launch.state.lastProgress?.lines || [])], seconds };
  };
  const first = await start();
  expect('a first start builds, or finds its last build here standing', first.build?.ok, `${JSON.stringify(first.build)} in ${first.seconds} s`);
  const again = await start();
  expect('again with nothing changed: no build, "aktualne", no properties read', again.build?.ok && again.build.upToDate
    && again.lines.some((l) => l.startsWith('Kompilacja: aktualne')) && !again.lines.some((l) => l.startsWith('Odczytywanie właściwości projektu')),
  `${JSON.stringify(again.build)} in ${again.seconds} s: ${again.lines.join(' | ')}`);
  const source = (await vscode.workspace.findFiles(new vscode.RelativePattern(path.dirname(project), '**/*.cs'), '**/{bin,obj}/**', 1))[0].fsPath;
  const touched = new Date();
  fs.utimesSync(source, touched, touched);
  const changed = await start();
  expect(`after ${path.basename(source)}'s time changed: built`, changed.build?.ok && !changed.build.upToDate, `${JSON.stringify(changed.build)} in ${changed.seconds} s`);
  // A build under way (as the Solution Explorer's or tasks.json's): the start waits for it, then checks.
  const task = new vscode.Task({ type: 'shell', task: 'up-to-date check build' }, vscode.TaskScope.Workspace, 'up-to-date check build', 'tests',
    new vscode.ShellExecution('dotnet', ['build', project], { cwd: path.dirname(project) }));
  const building = await vscode.tasks.executeTask(task);
  const buildEnded = ended(building);
  let endedFirst = false;
  buildEnded.then(() => (endedFirst = !api.launch.state.lastBuild));
  const waited = await start();
  expect('a start while a dotnet build runs waits for it, then starts', endedFirst && waited.build?.ok && waited.lines[0]?.startsWith('Oczekiwanie na zakończenie trwającej kompilacji'),
    `build ended first ${endedFirst}, ${JSON.stringify(waited.build)}: ${waited.lines.join(' | ')}`);
  return results;
}

// Roslyn's References CodeLens above a member, clicked: its client command roslyn.client.peekReferences opens the
// references in a peek, as many as the lens counts.
async function referencesLensChecks() {
  const { doc, pos } = await position('Contoso.Core/Authorization/RightsChecker.cs', 'bool CheckRightsExpr(', 5);
  await vscode.window.showTextDocument(doc);
  let lens;
  for (let i = 0; i < 20 && !lens; i++) {
    const lenses = (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri, 100)) || [];
    lens = lenses.find((l) => l.range.start.line === pos.line && l.command?.command === 'roslyn.client.peekReferences');
    if (!lens) await sleep(3000);
  }
  if (!lens) return [{ name: 'References lens on CheckRightsExpr', ok: false, got: ['no lens with roslyn.client.peekReferences on its line'] }];
  const count = Number(/\d+/.exec(lens.command.title)?.[0]);
  let shown, error;
  try {
    shown = await vscode.commands.executeCommand(lens.command.command, ...lens.command.arguments);
  } catch (e) {
    error = e.message;
  }
  await vscode.commands.executeCommand('closeReferenceSearch');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const ok = !error && count > 0 && shown?.length === count && shown.every((l) => l.uri && !(l.uri.fsPath === doc.uri.fsPath && l.range.start.line === pos.line));
  return [{ name: `clicking "${lens.command.title}" peeks the references`, ok,
    got: error ? [error] : [`${shown?.length} in the peek`, ...(shown || []).slice(0, 3).map((l) => `${path.basename(l.uri.fsPath)}:${l.range.start.line + 1}`)] }];
}

// Roslyn's other client commands, on edits made for the check and reverted after: two unused variables give a fix with
// Fix All (roslyn.client.fixAllCodeAction, scope Document) and the submenu of ways to suppress the warning
// (roslyn.client.nestedCodeAction); "override " in the class gives a completion item that is a complex edit
// (roslyn.client.completionComplexEdit).
async function clientCommandChecks() {
  const results = [];
  const { doc, pos } = await position('Contoso.Core/Authorization/AppUser.cs', 'RightsChecker.CheckRightsExpr(conditions, __GetModules', 0);
  const editor = await vscode.window.showTextDocument(doc);
  const run = async (command) => {
    try {
      return { result: await vscode.commands.executeCommand(command.command, ...(command.arguments || []).slice(0, 1), ...command.extra) };
    } catch (e) {
      return { error: e.message };
    }
  };
  try {
    const indent = doc.lineAt(pos.line).text.match(/^\s*/)[0];
    await editor.edit((e) => e.insert(new vscode.Position(pos.line, 0), `${indent}int shooterUnusedA;\n${indent}int shooterUnusedB;\n`));
    const at = new vscode.Position(pos.line, indent.length + 6);
    let actions = [];
    for (let i = 0; i < 20 && !actions.some((a) => a.command?.command === 'roslyn.client.fixAllCodeAction'); i++) {
      await sleep(1500);
      actions = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(at, at))) || [];
    }
    const titles = actions.map((a) => `${a.title}${a.command ? ` [${a.command.command.replace('roslyn.client.', '')}]` : ''}`);
    const nested = actions.find((a) => a.command?.command === 'roslyn.client.nestedCodeAction');
    const inner = nested?.command.arguments[0].NestedCodeActions || [];
    const pragma = inner.find((a) => /#pragma/.test(a.title)) || inner[0];
    const n = pragma && await run({ ...nested.command, extra: [pragma.title] });
    results.push({ name: 'nestedCodeAction: a suppression picked from the submenu is applied', ok: !n?.error && /#pragma warning disable/.test(doc.getText()),
      got: [n?.error || `${inner.length} under "${nested?.title}"`, `picked: ${pragma?.title}`] });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await editor.edit((e) => e.insert(new vscode.Position(pos.line, 0), `${indent}int shooterUnusedA;\n${indent}int shooterUnusedB;\n`));
    actions = [];
    for (let i = 0; i < 20 && !actions.some((a) => a.command?.command === 'roslyn.client.fixAllCodeAction'); i++) {
      await sleep(1500);
      actions = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(at, at))) || [];
    }
    const fixAll = actions.find((a) => a.command?.command === 'roslyn.client.fixAllCodeAction');
    const f = fixAll && await run({ ...fixAll.command, extra: ['Document'] });
    results.push({ name: 'fixAllCodeAction: Fix All in Document removes both variables', ok: !!fixAll && !f.error && !/shooterUnused/.test(doc.getText()),
      got: [f?.error || `"${fixAll?.title}" with ${fixAll?.command.arguments[0].FixAllFlavors?.join('/')}`, `${(doc.getText().match(/shooterUnused/g) || []).length} left`, ...(fixAll ? [] : titles.slice(0, 8))] });
    await vscode.commands.executeCommand('workbench.action.files.revert');

    const classLine = doc.getText().split(/\r?\n/).findIndex((l) => /\bclass AppUser\b/.test(l));
    let brace = classLine;
    while (!doc.lineAt(brace).text.includes('{')) brace++;
    const member = doc.lineAt(brace).text.match(/^\s*/)[0] + '    ';
    await editor.edit((e) => e.insert(new vscode.Position(brace + 1, 0), `${member}override \n`));
    const caret = new vscode.Position(brace + 1, member.length + 9);
    let item;
    for (let i = 0; i < 10 && !item; i++) {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, caret, undefined, 100);
      item = list?.items.find((x) => /^ToString\(/.test(typeof x.label === 'string' ? x.label : x.label.label));
      if (!item) await sleep(1500);
    }
    const c = item?.command?.command === 'roslyn.client.completionComplexEdit' && await vscode.commands.executeCommand(item.command.command, ...item.command.arguments).then((r) => ({ r }), (e) => ({ error: e.message }));
    const line = doc.lineAt(brace + 1).text.trim();
    results.push({ name: 'completionComplexEdit: override ToString() written in', ok: !!c && !c.error && /override string ToString\(\)/.test(doc.getText()),
      got: [c?.error || `command ${item?.command?.command}`, line] });
  } finally {
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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
  // While Razor's views are still being prepared, F5 and a test run are refused (no debug session, no run).
  let blocked;
  if (!api.loading()?.done) {
    let session;
    const d = vscode.debug.onDidStartDebugSession((x) => (session = x));
    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], api.startup.startupEntry());
    await api.testExplorer.explorer.runIn([{}], false);
    d.dispose();
    blocked = { ok: !started && !session && !api.testExplorer.explorer.running, got: `while "${api.loading()?.now()}": start ${started}, session ${session?.name}, tests running ${api.testExplorer.explorer.running}` };
  }
  // What the bottom right said while the server started and loaded the solution, then while Razor made its views ready,
  // and that it closed once Razor answered.
  for (let i = 0; i < 1200 && !api.loading()?.done; i++) await sleep(250);
  const said = api.loading()?.lines || [];
  const loadingOk = api.loading()?.done && said.some((l) => l.startsWith('Uruchamianie serwera C#')) && said.some((l) => /^Wczytywanie rozwiązania WebApp \(5 projektów\)… \d+ s$/.test(l))
    && said.some((l) => l.startsWith('Przygotowywanie widoków Razor (.cshtml)…')) && /^Rozwiązanie WebApp wczytane w \d+ s/.test(said[said.length - 1]);
  lines.push(`${loadingOk ? 'PASS' : 'FAIL'}  loading: the bottom right says it until the projects are loaded and Razor answers: ${[...new Set(said.map((l) => l.replace(/\d+ s$/, 'N s')))].join(' | ')}`);
  let failedLoading = loadingOk ? 0 : 1;
  const took = api.loading()?.timings;
  if (took) lines.push(`INFO  loading took: server ${(took.server / 1000).toFixed(1)} s, projects ${(took.projects / 1000).toFixed(1)} s, Razor ${(took.razor / 1000).toFixed(1)} s`);
  if (blocked) {
    lines.push(`${blocked.ok ? 'PASS' : 'FAIL'}  loading: F5 and test runs wait until it has loaded: ${blocked.got}`);
    failedLoading += blocked.ok ? 0 : 1;
  }
  // Once it has closed, a .cshtml opened then answers at once: Razor's hover on C# and its colours.
  const razorCheck = defaultChecks.find((c) => c.kind === 'hover');
  if (!process.env.CHECKS_FILE && razorCheck) {
    const opened = Date.now();
    const { doc } = await position(razorCheck.file, razorCheck.needle, razorCheck.off);
    const hover = await ask(razorCheck);
    const tokens = await vscode.commands.executeCommand('vscode.provideDocumentRangeSemanticTokens', doc.uri, new vscode.Range(0, 0, doc.lineCount, 0));
    const took = Date.now() - opened;
    const razorOk = hover.some((h) => h.includes(razorCheck.expect)) && tokens?.data.length > 0 && took < 5000;
    lines.push(`${razorOk ? 'PASS' : 'FAIL'}  loading: a .cshtml answers right after the notice closes: hover and ${tokens ? tokens.data.length / 5 : 0} tokens in ${took} ms`);
    failedLoading += razorOk ? 0 : 1;
  }
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
  if (checks.references || (!process.env.CHECKS_FILE && process.env.SKIP_REFERENCES !== '1')) {
    for (const r of await referencesLensChecks()) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  CodeLens: ${r.name}: ${r.got.join('; ').slice(0, 200)}`);
    }
  }
  if (checks.clientCommands || (!process.env.CHECKS_FILE && process.env.SKIP_CLIENT_COMMANDS !== '1')) {
    for (const r of await clientCommandChecks()) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  client commands: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
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
  if (checks.properties || (!process.env.CHECKS_FILE && process.env.SKIP_PROPERTIES !== '1')) {
    for (const r of await propertiesChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  properties: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.propertiesWindow || (!process.env.CHECKS_FILE && process.env.SKIP_PROPERTIES_WINDOW !== '1')) {
    for (const r of await propertiesWindowChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  properties window: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.configurationManager || (!process.env.CHECKS_FILE && process.env.SKIP_CONFIGURATION_MANAGER !== '1')) {
    for (const r of await configurationManagerChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  configuration manager: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.publish || (!process.env.CHECKS_FILE && process.env.SKIP_PUBLISH !== '1')) {
    for (const r of await publishChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  publish: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
    }
  }
  if (checks.nuget || (!process.env.CHECKS_FILE && process.env.SKIP_NUGET !== '1')) {
    for (const r of await nugetChecks(api)) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  NuGet: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
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
  if (checks.upToDate || (!process.env.CHECKS_FILE && process.env.SKIP_UP_TO_DATE !== '1')) {
    for (const r of await upToDateChecks(api, checks.upToDate || 'WebApp/WebApp.csproj')) {
      failed += r.ok ? 0 : 1;
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  up to date: ${r.name}: ${r.got.join('; ').slice(0, 300)}`);
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
