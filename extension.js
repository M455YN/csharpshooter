// C# and Razor through Microsoft's roslyn-language-server, debugging through Passenger's debug adapter.
const vscode = require('vscode');
const { t, tn } = require('./l10n');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { LanguageClient, State } = require('vscode-languageclient/node');
const { registerSolutionView } = require('./solution');
const { registerSolutionSearch } = require('./solution-search');
const { registerSearchEverywhere } = require('./search-everywhere');
const { registerDataVisualizer } = require('./data-visualizer');
const { registerRazorEnter } = require('./razor-enter');
const { registerPublishPage } = require('./publish-page');
const { registerNuGetPage } = require('./nuget-page');
const { registerLaunch } = require('./launch');
const { registerCompat } = require('./compat');
const { registerTaskRunner } = require('./task-runner');
const { registerStartup } = require('./startup');
const { launchProgress } = require('./build-progress');
const { readSolution } = require('./solution');
const { TranslatingAdapter } = require('./debug-l10n');

// VS Code writes file URIs as file:///d%3A/...; Roslyn's Razor cannot read an escaped drive colon, so files go as Node
// writes them (file:///D:/.../C%23/...), which escapes only what a URI must (# in "C#" folders, spaces).
const toServerUri = (uri) => (uri.scheme === 'file' ? pathToFileURL(uri.fsPath).href : uri.toString());

let client;
let loading; // what the start is doing, until the projects are loaded (for the tests: its lines)
let output;
// Resolved once the server has loaded the solution; the tests wait on it.
let readyResolve;
let ready = new Promise((r) => (readyResolve = r));

// Server -> client requests Razor makes about the HTML in a .cshtml/.razor. Without an HTML server of our own they
// answer empty, so Razor goes on with its own part (C#, tag helpers, components).
const emptyListRequests = [
  'textDocument/formatting', 'textDocument/rangeFormatting', 'textDocument/onTypeFormatting', 'textDocument/codeAction',
  'textDocument/documentHighlight', 'textDocument/references', 'textDocument/foldingRange', 'textDocument/documentColor',
  'textDocument/colorPresentation', 'textDocument/implementation', 'textDocument/definition', 'textDocument/documentSymbol',
];
const nullRequests = ['textDocument/hover', 'textDocument/signatureHelp', 'textDocument/linkedEditingRange', 'textDocument/rename',
  'textDocument/willSaveWaitUntil', 'completionItem/resolve', 'codeAction/resolve'];


/** Says at the bottom right, and with a spinner in the status bar, that C# is not ready yet while the server starts and
 *  loads the solution, as VS says it is loading the solution: on a slow machine that takes a while, and C# help, F12 and
 *  the Solution Explorer's symbols wait for it. */
function startLoading() {
  const progress = launchProgress('C#', { cancellable: false }); // nothing to cancel: the server goes on loading
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  bar.command = 'csharpShooter.showOutput';
  bar.tooltip = t('The C# server is loading the solution: C# completion, Go to Definition and Razor start once the projects are loaded.');
  const t0 = Date.now();
  let stage = '';
  const show = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    progress.report(`${stage} ${s} s`);
    bar.text = `$(sync~spin) ${stage.replace(/…$/, '')}`;
  };
  const timer = setInterval(show, 1000);
  bar.show();
  const handle = {
    lines: progress.lines,
    done: false,
    stage(text) {
      stage = text;
      show();
    },
    finish(message) {
      if (handle.done) return;
      handle.done = true;
      clearInterval(timer);
      progress.done();
      bar.dispose();
      if (message) vscode.window.setStatusBarMessage(`$(check) ${message}`, 15000);
      progress.lines.push(message || '');
    },
  };
  return handle;
}

function setting(name) {
  return vscode.workspace.getConfiguration('csharpShooter').get(name);
}

function bundled(context, configured, ...parts) {
  return configured ? configured : context.asAbsolutePath(path.join(...parts));
}

async function findSolution() {
  const configured = setting('solution');
  if (configured) return configured;
  const found = await vscode.workspace.findFiles('**/*.{sln,slnx}', '**/{node_modules,bin,obj}/**', 10);
  // shortcut: first solution, shallowest path; a picker would be the upgrade for workspaces with several.
  found.sort((a, b) => a.fsPath.split(path.sep).length - b.fsPath.split(path.sep).length);
  return found[0]?.fsPath;
}

async function startServer(context) {
  loading?.finish();
  loading = startLoading();
  loading.stage(t('Starting the C# server…'));
  const serverDll = bundled(context, setting('serverPath'), 'server', 'Microsoft.CodeAnalysis.LanguageServer.dll');
  if (!fs.existsSync(serverDll)) {
    loading.finish();
    vscode.window.showErrorMessage(t('C# language server not found: {0}. Run "npm run fetch-server" in the extension folder.', serverDll));
    return;
  }
  const logDir = path.join(context.logUri.fsPath, 'roslyn');
  fs.mkdirSync(logDir, { recursive: true });
  const args = [serverDll, '--stdio', '--logLevel', 'Information', '--telemetryLevel', 'off',
    '--extensionLogDirectory', logDir, '--clientProcessId', String(process.pid)];
  // A project with RazorCompileOnBuild=false hides its .cshtml from the Razor generator, which the server's Razor needs.
  if (setting('razorViewsInDesignTime')) {
    args.push('--csharpDesignTimePath', context.asAbsolutePath(path.join('designtime', 'CSharpShooter.Razor.DesignTime.targets')));
  }

  client = new LanguageClient('csharpShooter', 'C# (Roslyn)',
    { command: 'dotnet', args },
    {
      // Roslyn's own features are for C#. Razor registers its own for .cshtml/.razor (language aspnetcorerazor, as VS and
      // Passenger open them): its trigger characters (@, =, ", space…) and no C# commit characters, so '-' in asp-for
      // goes on typing the name instead of taking the first item.
      documentSelector: [{ scheme: 'file', language: 'csharp' }],
      outputChannel: output,
      uriConverters: { code2Protocol: toServerUri, protocol2Code: (value) => vscode.Uri.parse(value) },
      middleware: {
        // Roslyn asks for its options by section; null leaves each at the server's default.
        workspace: { configuration: (params) => params.items.map(() => null) },
        // While the solution loads, Roslyn colours a file from what it has so far: the types of NuGet packages and other
        // projects are not resolved yet and stay plain names. VS Code asks C# by range, which the server's refresh does not
        // reach, so a file opened then kept those colours until Razor's views were ready (on SkillBox a minute) or it was
        // scrolled. Asked again a moment later, until the notice closes or the answer stays the same.
        provideDocumentRangeSemanticTokens: async (document, range, token, next) => {
          const tokens = await next(document, range, token);
          if (document.languageId === 'csharp' && loading && !loading.done && tokens) {
            const key = `${document.uri} ${range.start.line}`;
            const data = tokens.data.join();
            if (loadingColours.get(key) !== data) recolourSoon();
            loadingColours.set(key, data);
          }
          return tokens;
        },
      },
    });

  const t0 = Date.now();
  let solutionName = '';
  let projectFiles = [];
  client.onNotification('workspace/projectInitializationComplete', async () => {
    output.appendLine('Projects loaded.');
    readyResolve();
    // C# and F12 answer now, but Razor first generates the C# of a project's views (on a web project with many .cshtml,
    // tens of seconds), and until then a .cshtml has no colours, completion or hover: the notice stays up for that.
    const notice = loading;
    if (!notice || notice.done) return;
    notice.stage(t('Preparing Razor views (.cshtml)…'));
    const razorStart = Date.now();
    await Promise.race([razorAnswers(projectFiles), new Promise((r) => setTimeout(r, 5 * 60 * 1000))]).catch(() => {});
    output.appendLine(`Razor answered after ${Math.round((Date.now() - razorStart) / 1000)} s.`);
    notice.finish(t('Solution {0} loaded in {1} s: C# completion, F12 and Razor ready', solutionName, Math.round((Date.now() - t0) / 1000)));
    recolour();
    loadingColours.clear();
  });
  client.onNotification('window/_roslyn_showToast', (toast) => output.appendLine(`[toast] ${toast.message}`));
  client.onRequest('razor/updateHtml', () => null);
  client.onRequest('textDocument/completion', () => ({ isIncomplete: false, items: [] }));
  for (const method of emptyListRequests) client.onRequest(method, () => []);
  for (const method of nullRequests) client.onRequest(method, () => null);

  try {
    await client.start();
  } catch (e) {
    loading.finish();
    throw e;
  }
  const solution = await findSolution();
  if (solution) {
    solutionName = path.basename(solution, path.extname(solution));
    try {
      const walk = (node) => [...node.projects, ...node.folders.flatMap(walk)];
      projectFiles = walk(readSolution(solution));
    } catch {
      // only for the message and Razor's views
    }
    const count = projectFiles.length;
    loading.stage(count ? tn(count, 'Loading solution {1} (1 project)…', 'Loading solution {1} ({0} projects)…', solutionName) : t('Loading solution {0}…', solutionName));
    output.appendLine(`Opening ${solution}`);
    await client.sendNotification('solution/open', { solution: toServerUri(vscode.Uri.file(solution)) });
  } else {
    loading.stage(t('Loading projects…'));
    const projects = await vscode.workspace.findFiles('**/*.csproj', '**/{node_modules,bin,obj}/**');
    projectFiles = projects.map((p) => p.fsPath);
    await client.sendNotification('project/open', { projects: projects.map(toServerUri) });
  }
}

/** Resolves once Razor colours the views open in editors and a few of each project's own. Its colours need the views'
 *  C# generated and compiled, which Razor does for a whole project at once, and its first view with the project's tag
 *  helpers (<page-title>, <grid-modal>) binds them, on SkillBox about as long again: views of a project are asked one
 *  after another until one answers at once. Asking starts that work now, so a view opened later answers at once. */
async function razorAnswers(projectFiles) {
  const colours = async (uri) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand('vscode.provideDocumentRangeSemanticTokens', doc.uri, new vscode.Range(0, 0, doc.lineCount, 0));
  };
  const open = vscode.window.visibleTextEditors.map((e) => e.document.uri).filter((u) => /\.(cshtml|razor)$/i.test(u.fsPath));
  await Promise.all([...open.map(colours), ...projectFiles.map(async (project) => {
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(path.dirname(project), '**/*.{cshtml,razor}'), '**/{node_modules,bin,obj}/**', 30);
    const tagHelpers = (u) => { try { return /<[a-z]+-[a-z]/.test(fs.readFileSync(u.fsPath, 'utf8')); } catch { return false; } };
    // pages before _ViewStart/_ViewImports, which hold little C#; those with tag helper elements first
    const pages = found.filter((u) => !path.basename(u.fsPath).startsWith('_')).map((u) => [u, tagHelpers(u)]);
    const views = [...pages.filter((p) => p[1]), ...pages.filter((p) => !p[1])].map((p) => p[0]).slice(0, 5);
    for (const view of views) {
      const asked = Date.now();
      await colours(view);
      if (Date.now() - asked < 2000) break;
    }
  })]);
}

/** Razor colours a view by range, and so does Roslyn a .cs file, and the language client passes the server's semantic
 *  tokens refresh on to whole-document providers only: a file coloured while the projects loaded keeps those colours
 *  until scrolled or edited. A range provider registered and removed has VS Code ask again for every file on screen. */
function recolour() {
  vscode.languages.registerDocumentRangeSemanticTokensProvider({ language: 'aspnetcorerazor' },
    { provideDocumentRangeSemanticTokens: () => null }, new vscode.SemanticTokensLegend([])).dispose();
}

let recolourTimer;
const loadingColours = new Map(); // a .cs file's last colours by range while the projects load
function recolourSoon() {
  recolourTimer ??= setTimeout(() => {
    recolourTimer = undefined;
    recolour();
  }, 3000);
}

/** Roslyn's References CodeLens runs this client command with the document and the member's start (the C# extension
 *  registers it); the references open in a peek under the lens, as VS opens its list there. The declaration is left
 *  out, as in the lens's count. */
async function peekReferences(uri, position) {
  if (!client) return;
  const found = await client.sendRequest('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: false } });
  const locations = await client.protocol2CodeConverter.asReferences(found || []);
  await vscode.commands.executeCommand('editor.action.showReferences', vscode.Uri.parse(uri), client.protocol2CodeConverter.asPosition(position), locations);
  return locations; // for the tests
}

async function stopServer() {
  if (client && client.state !== State.Stopped) await client.stop();
  client = undefined;
  ready = new Promise((r) => (readyResolve = r));
}

class DebugAdapterFactory {
  constructor(context) { this.context = context; }
  createDebugAdapterDescriptor() {
    const exe = bundled(this.context, setting('debuggerPath'), 'debugger', process.platform === 'win32' ? 'Passenger.DebugAdapter.exe' : 'Passenger.DebugAdapter');
    if (!fs.existsSync(exe)) throw new Error(t('Debug adapter not found: {0}', exe));
    return new vscode.DebugAdapterInlineImplementation(new TranslatingAdapter(exe, ['--interpreter=vscode']));
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel('CSharpShooter');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.showOutput', () => output.show()));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('csharpshooter', new DebugAdapterFactory(context)));
  context.subscriptions.push(vscode.commands.registerCommand('roslyn.client.peekReferences', peekReferences));
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.restartServer', async () => {
    await stopServer();
    await startServer(context);
  }));
  const solutionView = registerSolutionView(context, findSolution);
  // With a solution in the workspace, the side bar opens on the Solution Explorer, as VS opens on it (an extension's
  // icon cannot be put above VS Code's Explorer; once dragged there, VS Code keeps it).
  findSolution().then((solution) => solution && vscode.commands.executeCommand('workbench.view.extension.csharpShooter'));
  solutionView.search = registerSolutionSearch(context, findSolution, solutionView);
  const searchEverywhere = registerSearchEverywhere(context, solutionView);
  const dataVisualizer = registerDataVisualizer(context);
  registerRazorEnter(context);
  // Texts already shown (trees, the status bar, open pages) keep their language until the window reloads.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration('csharpShooter.uiLanguage')) return;
    const reload = t('Reload Window');
    if ((await vscode.window.showInformationMessage(t("CSharpShooter's texts change language once the window reloads."), reload)) === reload) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }));
  const publishPage = registerPublishPage(context, require('./solution').newPublishProfile);
  const nugetPage = registerNuGetPage(context, findSolution);
  const launch = registerLaunch(context);
  registerCompat(context, output, launch.provider);
  const taskRunner = registerTaskRunner(context, findSolution);
  const startup = registerStartup(context, findSolution, launch);
  launch.provider.startup = startup.startup;
  solutionView.provider.startup = startup.startup;
  const markStartup = async () => solutionView.provider.setStartup(await startup.startup.project());
  startup.startup.onDidChange(markStartup);
  markStartup();
  await startServer(context);
  return { whenReady: () => ready, loading: () => loading, solutionView, launch, taskRunner, startup, searchEverywhere, dataVisualizer, publishPage, nugetPage, extensionPath: context.extensionPath };
}

async function deactivate() {
  await stopServer();
}

module.exports = { activate, deactivate };
