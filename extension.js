// C# and Razor through Microsoft's roslyn-language-server, debugging through Passenger's debug adapter.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { LanguageClient, State } = require('vscode-languageclient/node');

// VS Code writes file URIs as file:///d%3A/...; Roslyn's Razor cannot read an escaped drive colon, so files go as Node
// writes them (file:///D:/.../C%23/...), which escapes only what a URI must (# in "C#" folders, spaces).
const toServerUri = (uri) => (uri.scheme === 'file' ? pathToFileURL(uri.fsPath).href : uri.toString());

let client;
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
  const serverDll = bundled(context, setting('serverPath'), 'server', 'Microsoft.CodeAnalysis.LanguageServer.dll');
  if (!fs.existsSync(serverDll)) {
    vscode.window.showErrorMessage(`C# language server not found: ${serverDll}. Run "npm run fetch-server" in the extension folder.`);
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
      documentSelector: [
        { scheme: 'file', language: 'csharp' },
        { scheme: 'file', language: 'razor' },
        { scheme: 'file', language: 'aspnetcorerazor' },
      ],
      outputChannel: output,
      uriConverters: { code2Protocol: toServerUri, protocol2Code: (value) => vscode.Uri.parse(value) },
      middleware: {
        // Roslyn asks for its options by section; null leaves each at the server's default.
        workspace: { configuration: (params) => params.items.map(() => null) },
      },
    });

  client.onNotification('workspace/projectInitializationComplete', () => {
    output.appendLine('Projects loaded.');
    readyResolve();
  });
  client.onNotification('window/_roslyn_showToast', (toast) => output.appendLine(`[toast] ${toast.message}`));
  client.onRequest('razor/updateHtml', () => null);
  client.onRequest('textDocument/completion', () => ({ isIncomplete: false, items: [] }));
  for (const method of emptyListRequests) client.onRequest(method, () => []);
  for (const method of nullRequests) client.onRequest(method, () => null);

  await client.start();
  const solution = await findSolution();
  if (solution) {
    output.appendLine(`Opening ${solution}`);
    await client.sendNotification('solution/open', { solution: toServerUri(vscode.Uri.file(solution)) });
  } else {
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
    if (!fs.existsSync(exe)) throw new Error(`Debug adapter not found: ${exe}`);
    return new vscode.DebugAdapterExecutable(exe, ['--interpreter=vscode']);
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel('CSharpShooter');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('csharpshooter', new DebugAdapterFactory(context)));
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.restartServer', async () => {
    await stopServer();
    await startServer(context);
  }));
  await startServer(context);
  return { whenReady: () => ready };
}

async function deactivate() {
  await stopServer();
}

module.exports = { activate, deactivate };
