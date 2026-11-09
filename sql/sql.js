// T-SQL in .sql files through Microsoft's SQL Tools Service (MIT; the server behind vscode-mssql), started on the
// installed .NET as the C# server is once a .sql file is open: its IntelliSense and syntax errors, with no connection to a
// server. SQL that lives in code (csharpShooter.sql.checkQuery, a Razor Tag Helper's for C# Razor Tag Helper Support) is
// checked by CSharpShooter.SqlCheck (sqlcheck/), the service's own parser in a process of its own: the service waits
// 750 ms before each check and a new one cancels the one waiting, this answers at once.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { table, language } = require('../l10n');
const { LanguageClient } = require('vscode-languageclient/node');
const { registerRazorSql } = require('./razor-sql');

const T = table({
  noServer: 'SQL Tools Service not found: {0}. Run "npm run fetch-sqltools" in the extension folder.',
});

function registerSql(context) {
  const output = vscode.window.createOutputChannel('CSharpShooter SQL');
  let client;
  let starting;
  let missingShown = false;
  context.subscriptions.push(output, { dispose: () => client?.stop() });

  const toolsDir = () => {
    const configured = vscode.workspace.getConfiguration('csharpShooter').get('sqlToolsPath');
    return configured ? path.dirname(configured) : context.asAbsolutePath('sqltools');
  };

  function start() {
    if (client) return Promise.resolve(client);
    if (starting) return starting;
    const configured = vscode.workspace.getConfiguration('csharpShooter').get('sqlToolsPath');
    const dll = configured || path.join(toolsDir(), 'MicrosoftSqlToolsServiceLayer.dll');
    if (!fs.existsSync(dll)) {
      if (!missingShown) vscode.window.showErrorMessage(T.noServer(dll));
      missingShown = true;
      return Promise.resolve(undefined);
    }
    const logDir = path.join(context.logUri.fsPath, 'sqltools');
    const dataDir = context.globalStorageUri.fsPath;
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const args = [dll, '--log-file', path.join(logDir, 'sqltools.log'), '--locale', language(),
      '--application-name', 'CSharpShooter', '--data-path', dataDir, '--parallel-message-processing'];
    const next = new LanguageClient('csharpShooterSql', 'T-SQL (SQL Tools Service)', { command: 'dotnet', args },
      { documentSelector: [{ language: 'sql', scheme: 'file' }, { language: 'sql', scheme: 'untitled' }], outputChannel: output });
    starting = next.start().then(() => (client = next), (e) => {
      starting = undefined;
      output.appendLine(String(e?.stack || e));
      throw e;
    });
    return starting;
  }

  // CSharpShooter.SqlCheck: one JSON line per query each way, answers matched by id; started again if it ends.
  let checker;
  let nextId = 0;
  const pending = new Map(); // id -> resolve of its errors
  function startChecker() {
    if (checker) return checker;
    const dll = path.join(toolsDir(), 'CSharpShooter.SqlCheck.dll');
    if (!fs.existsSync(dll)) return undefined;
    const proc = spawn('dotnet', [dll, language()], { windowsHide: true });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const { id, errors } = JSON.parse(line);
        pending.get(id)?.(errors);
      } catch (e) {
        output.appendLine(`SqlCheck: ${line}`);
      }
    });
    proc.stderr.on('data', (d) => output.appendLine(`SqlCheck: ${d}`));
    const ended = () => {
      if (checker === proc) checker = undefined;
      for (const resolve of pending.values()) resolve([]);
    };
    proc.on('exit', ended);
    proc.on('error', ended);
    return (checker = proc);
  }
  context.subscriptions.push({ dispose: () => checker?.kill() });

  /** A query's syntax errors, as the service would underline them, with no connection: [{ line, character, endLine,
   *  endCharacter, message }], 0-based in the text given; none when SqlCheck is missing or does not answer. */
  function checkQuery(text) {
    const proc = startChecker();
    if (!proc) return Promise.resolve([]);
    const id = ++nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), 10000);
      pending.set(id, (errors) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(errors || []);
      });
      proc.stdin.write(`${JSON.stringify({ id, text: String(text) })}\n`);
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('csharpShooter.sql.checkQuery', checkQuery),
    // The service only once a .sql file is open: a Razor page's checks need SqlCheck alone.
    vscode.workspace.onDidOpenTextDocument((d) => d.languageId === 'sql' && start().catch(() => {})),
  );
  if (vscode.workspace.textDocuments.some((d) => d.languageId === 'sql')) start().catch(() => {});
  startChecker();
  const razor = registerRazorSql(context, checkQuery);
  return { checkQuery, razor, client: () => client };
}

module.exports = { registerSql };
