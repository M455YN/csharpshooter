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
const { registerLaunch } = require('./launch');
const { registerCompat } = require('./compat');
const { registerTaskRunner } = require('./task-runner');
const { registerStartup } = require('./startup');
const { launchProgress } = require('./build-progress');
const { readSolution } = require('./solution');

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
      },
    });

  const t0 = Date.now();
  let solutionName = '';
  client.onNotification('workspace/projectInitializationComplete', () => {
    output.appendLine('Projects loaded.');
    loading?.finish(t('Solution {0} loaded in {1} s: C# completion, F12 and Razor ready', solutionName, Math.round((Date.now() - t0) / 1000)));
    readyResolve();
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
    let count = 0;
    try {
      const walk = (node) => node.projects.length + node.folders.reduce((n, f) => n + walk(f), 0);
      count = walk(readSolution(solution));
    } catch {
      // the count is only for the message
    }
    loading.stage(count ? tn(count, 'Loading solution {1} (1 project)…', 'Loading solution {1} ({0} projects)…', solutionName) : t('Loading solution {0}…', solutionName));
    output.appendLine(`Opening ${solution}`);
    await client.sendNotification('solution/open', { solution: toServerUri(vscode.Uri.file(solution)) });
  } else {
    loading.stage(t('Loading projects…'));
    const projects = await vscode.workspace.findFiles('**/*.csproj', '**/{node_modules,bin,obj}/**');
    await client.sendNotification('project/open', { projects: projects.map(toServerUri) });
  }
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
    return new vscode.DebugAdapterExecutable(exe, ['--interpreter=vscode']);
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel('CSharpShooter');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.showOutput', () => output.show()));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('csharpshooter', new DebugAdapterFactory(context)));
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
  return { whenReady: () => ready, loading: () => loading, solutionView, launch, taskRunner, startup, searchEverywhere, dataVisualizer, publishPage, extensionPath: context.extensionPath };
}

async function deactivate() {
  await stopServer();
}

module.exports = { activate, deactivate };
