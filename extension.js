// C# and Razor through Microsoft's roslyn-language-server.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { LanguageClient, State } = require('vscode-languageclient/node');

let client;
let output;
// Resolved once the server has loaded the solution; the tests wait on it.
let readyResolve;
let ready = new Promise((r) => (readyResolve = r));

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

  client = new LanguageClient('csharpShooter', 'C# (Roslyn)',
    { command: 'dotnet', args },
    {
      documentSelector: [
        { scheme: 'file', language: 'csharp' },
        { scheme: 'file', language: 'razor' },
        { scheme: 'file', language: 'aspnetcorerazor' },
      ],
      outputChannel: output,
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

  await client.start();
  const solution = await findSolution();
  if (solution) {
    output.appendLine(`Opening ${solution}`);
    await client.sendNotification('solution/open', { solution: vscode.Uri.file(solution).toString() });
  } else {
    const projects = await vscode.workspace.findFiles('**/*.csproj', '**/{node_modules,bin,obj}/**');
    await client.sendNotification('project/open', { projects: projects.map((p) => p.toString()) });
  }
}

async function stopServer() {
  if (client && client.state !== State.Stopped) await client.stop();
  client = undefined;
  ready = new Promise((r) => (readyResolve = r));
}

async function activate(context) {
  output = vscode.window.createOutputChannel('CSharpShooter');
  context.subscriptions.push(output);
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
