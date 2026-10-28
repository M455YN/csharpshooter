// The first .sql file opened offers CSharpShooter SQL (M455YN.csharpshooter-sql), its SSMS-like editor, when it is not
// installed: once a window until Never is chosen, never forced (an extension pack would install it for everyone).
const vscode = require('vscode');
const { table } = require('./l10n');

const SQL_EXTENSION = 'M455YN.csharpshooter-sql';
const T = table({
  offer: 'Open .sql files in an editor like SSMS 22 and Visual Studio 2026 (connections, results below the query, Object Explorer)? It is CSharpShooter SQL, an extension of its own.',
  install: 'Install',
  notNow: 'Not now',
  never: 'Never',
});

function registerSqlOffer(context) {
  let shown = false; // asked in this window already (Not now asks again in the next)
  const asked = () => shown || context.globalState.get('csharpShooter.sqlOffered');
  const offer = async (document) => {
    if (document.languageId !== 'sql' || asked() || vscode.extensions.getExtension(SQL_EXTENSION)) return;
    shown = true;
    const answer = await vscode.window.showInformationMessage(T.offer, T.install, T.notNow, T.never);
    if (answer === T.install) await vscode.commands.executeCommand('workbench.extensions.installExtension', SQL_EXTENSION);
    if (answer === T.never) await context.globalState.update('csharpShooter.sqlOffered', 'never');
  };
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(offer));
  for (const document of vscode.workspace.textDocuments) offer(document);
}

module.exports = { registerSqlOffer, SQL_EXTENSION };
