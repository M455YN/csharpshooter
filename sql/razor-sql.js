// SQL in Razor pages: the SQL of a Tag Helper's attributes (select=@(@"..."), insert, lookup-sql...) opened in SQL Server
// Management Studio as a query, with a DECLARE for each value the app passes in, on a connection string of the page's
// project; and its syntax errors underlined where they are in the page, from checkQuery. C# Razor Tag Helper Support
// does the same when it is installed, and this steps aside for it, so a page never gets both.
const vscode = require('vscode');
const { table, language } = require('../l10n');
const { scanOpeningTags } = require('./razor/tags');
const { runnableSql, checkedSql, sourceOffset } = require('./razor/sql-query');
const { projectConnections, openInSsms } = require('./razor/ssms');

const TAG_HELPERS = 'M455YN.csharp-razor-taghelpers';
const DEFAULT_ATTRIBUTES = ['select', 'insert', 'update', 'delete', 'move', 'lookup-sql', 'sql'];
const T = table({
  openInSsms: 'Open {0} in SQL Server Management Studio',
  pickConnection: 'Connection string to open the query on',
  noSsms: 'SQL Server Management Studio was not found in Program Files.',
  declaresNote: 'Values the app gives this query: set them before running it.',
});

const isRazor = (doc) => ['razor', 'aspnetcorerazor'].includes(doc?.languageId) || /\.(cshtml|razor)$/i.test(doc?.uri.fsPath || '');
const config = (doc) => vscode.workspace.getConfiguration('csharpShooter.sql', doc?.uri);
// Tag Helper Support's lens and checks are the page's while it is installed.
const ours = () => !vscode.extensions.getExtension(TAG_HELPERS);

/** The page's SQL attributes: { tag, attribute, start, end } of each value, by csharpShooter.sql.razorAttributes. */
function sqlBlocks(doc) {
  const names = new Set((config(doc).get('razorAttributes') || DEFAULT_ATTRIBUTES).map((a) => String(a).toLowerCase()));
  const text = doc.getText();
  const blocks = [];
  for (const tag of scanOpeningTags(text)) {
    for (const a of tag.attributes || []) {
      if (a.contentStart != null && a.contentEnd > a.contentStart && names.has(String(a.name).toLowerCase())) {
        blocks.push({ tag: tag.name, attribute: a.name, start: a.contentStart, end: a.contentEnd });
      }
    }
  }
  return blocks;
}

async function openSqlInSsms(query) {
  const connections = projectConnections(query.file);
  let chosen = connections[0];
  if (connections.length > 1) {
    const item = await vscode.window.showQuickPick(
      connections.map((c) => ({ label: c.name, description: c.file, detail: c.connectionString.replace(/((?:password|pwd)\s*=\s*)("[^"]*"|'[^']*'|[^;]*)/gi, '$1********'), c })),
      { placeHolder: T.pickConnection });
    if (!item) return undefined;
    chosen = item.c;
  }
  const opened = openInSsms(query.text, query.name, chosen?.connectionString);
  if (opened.error) vscode.window.showErrorMessage(T.noSsms);
  return opened.file;
}

function registerRazorSql(context, checkQuery) {
  const changed = new vscode.EventEmitter();
  const collection = vscode.languages.createDiagnosticCollection('csharpShooter.sql.razor');
  const timers = new Map(); // document uri -> pending check
  const runs = new Map(); // document uri -> the latest check's number, so an older one's answer is dropped

  async function check(doc) {
    const key = doc.uri.toString();
    const run = (runs.get(key) || 0) + 1;
    runs.set(key, run);
    if (!ours() || !config(doc).get('razorDiagnostics', true)) return collection.delete(doc.uri);
    const text = doc.getText();
    const version = doc.version;
    const blocks = sqlBlocks(doc);
    // every block of the page at once: each answer comes in a few milliseconds
    const answers = await Promise.all(blocks.map((b) => checkQuery(checkedSql(text.slice(b.start, b.end)))));
    if (runs.get(key) !== run || doc.version !== version || doc.isClosed) return undefined;
    const found = [];
    blocks.forEach((b, i) => {
      const raw = text.slice(b.start, b.end);
      for (const e of answers[i]) {
        const start = b.start + sourceOffset(raw, e.line, e.character);
        const end = Math.max(start + 1, b.start + sourceOffset(raw, e.endLine, e.endCharacter));
        const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(start), doc.positionAt(end)), e.message, vscode.DiagnosticSeverity.Error);
        d.source = `SQL (${b.tag} ${b.attribute})`;
        found.push(d);
      }
    });
    return collection.set(doc.uri, found);
  }

  function schedule(doc, ms) {
    if (!isRazor(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      check(doc);
    }, ms));
  }
  const all = () => vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));

  context.subscriptions.push(
    changed,
    collection,
    vscode.commands.registerCommand('csharpShooter.sql.openInSsms', openSqlInSsms),
    vscode.languages.registerCodeLensProvider([{ language: 'razor' }, { language: 'aspnetcorerazor' }, { pattern: '**/*.{cshtml,razor}' }], {
      onDidChangeCodeLenses: changed.event,
      provideCodeLenses(doc) {
        if (!ours() || !config(doc).get('razorCodeLens', true)) return [];
        const text = doc.getText();
        const note = language() === 'pl' ? T.declaresNote : undefined;
        return sqlBlocks(doc).map((b) => new vscode.CodeLens(doc.lineAt(doc.positionAt(b.start).line).range, {
          title: `$(database) ${T.openInSsms(b.attribute)}`,
          command: 'csharpShooter.sql.openInSsms',
          arguments: [{ text: runnableSql(text.slice(b.start, b.end), `${b.tag} ${b.attribute}`, note), file: doc.uri.fsPath, name: `${b.tag}-${b.attribute}` }],
        }));
      },
    }),
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document, 250)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      clearTimeout(timers.get(d.uri.toString()));
      runs.delete(d.uri.toString());
      collection.delete(d.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('csharpShooter') && (changed.fire(), all())),
    vscode.extensions.onDidChange(() => (changed.fire(), all())),
  );
  all();
  return { sqlBlocks, check };
}

module.exports = { registerRazorSql };
