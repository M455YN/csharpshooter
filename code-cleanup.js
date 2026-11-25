// Run Code Cleanup as Visual Studio's (Profile 1) over what is chosen in the Solution Explorer: the solution, a project, a
// folder or a file. Each C# file under it (bin and obj left out) has its usings organized (the C# server's own
// fixes: unnecessary ones removed, the rest sorted) and is formatted as Format Document does, by its
// .editorconfig. A file that was open stays open, changed, for Undo; one that was not is saved.
const vscode = require('vscode');
const path = require('path');
const { t } = require('./l10n');

/** The folders whose C# files the item takes in: the solution's projects', a project's, a folder or the file's own. */
function rootsOf(item, readSolution) {
  if (item?.contextValue === 'solution') {
    const dirs = [];
    const walk = (node) => {
      for (const p of node.projects || []) dirs.push(path.dirname(p));
      for (const f of node.folders || []) walk(f);
    };
    walk(readSolution(item.file));
    return { dirs };
  }
  if (/^project( |$)/.test(item?.contextValue || '')) return { dirs: [path.dirname(item.file)] };
  if (item?.resourceUri) return item.contextValue === 'file' ? { files: [item.resourceUri.fsPath] } : { dirs: [item.resourceUri.fsPath] };
  const active = vscode.window.activeTextEditor?.document;
  return active?.languageId === 'csharp' ? { files: [active.uri.fsPath] } : { files: [] };
}

async function csharpFiles({ dirs = [], files = [] }) {
  const found = new Map(files.filter((f) => /\.cs$/i.test(f)).map((f) => [f.toLowerCase(), vscode.Uri.file(f)]));
  for (const dir of dirs) {
    for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(dir, '**/*.cs'), '**/{bin,obj,node_modules}/**')) {
      found.set(uri.fsPath.toLowerCase(), uri);
    }
  }
  return [...found.values()];
}

// The server's own fixes on a using directive, by their titles in its English and Polish.
// shortcut: only these two languages of the server's are known, add a title if it runs in another.
const REMOVE_USINGS = /^(Remove unnecessary usings|Usuń niepotrzebne użycia)$/i;
const SORT_USINGS = /^(Sort Usings|Sortuj usings)$/i;

/** The server's fix of that title at the file's first using directive, applied. */
async function applyAtUsings(document, kind, title) {
  const line = document.getText().split(/\r?\n/).findIndex((l) => /^\s*(global\s+)?using\s[^(]*;\s*$/.test(l));
  if (line < 0) return;
  const actions = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(line, 0, line, 0), kind, 10)) || [];
  const action = actions.find((a) => title.test(a.title));
  if (action?.edit) await vscode.workspace.applyEdit(action.edit);
}

/** Whether the server has the file in a project of the solution. Outside one (not loaded yet, or in no project) it finds
 *  every using unnecessary, as nothing resolves. */
async function inAProject(server, document) {
  const s = server();
  if (!s) return false;
  const got = await s.client.sendRequest('textDocument/_vs_getProjectContexts', { _vs_textDocument: { uri: s.toServerUri(document.uri) } });
  return (got?._vs_projectContexts || []).some((c) => !c._vs_is_miscellaneous);
}

/** One file cleaned as Profile 1 does: unnecessary usings removed, the rest sorted, then formatted. Whether it changed. */
async function cleanFile(uri, server) {
  const document = await vscode.workspace.openTextDocument(uri);
  const before = document.getText();
  if (await inAProject(server, document)) {
    await applyAtUsings(document, vscode.CodeActionKind.QuickFix.value, REMOVE_USINGS);
    await applyAtUsings(document, vscode.CodeActionKind.Refactor.value, SORT_USINGS);
  }
  const options = vscode.workspace.getConfiguration('editor', { uri, languageId: 'csharp' });
  const edits = (await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri,
    { tabSize: options.get('tabSize', 4), insertSpaces: options.get('insertSpaces', true) })) || [];
  if (edits.length) {
    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, edits);
    await vscode.workspace.applyEdit(edit);
  }
  return document.getText() !== before;
}

function registerCodeCleanup(context, readSolution, server) {
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.codeCleanup', async (item) => {
    const uris = await csharpFiles(rootsOf(item, readSolution));
    // not awaited: the message stays until dismissed, the command (and whoever runs it) is done
    if (!uris.length) { vscode.window.showInformationMessage(t('No C# files to clean up.')); return; }
    const open = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty || vscode.window.visibleTextEditors.some((e) => e.document === d)).map((d) => d.uri.toString()));
    let changed = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Code Cleanup'), cancellable: true }, async (progress, token) => {
      for (const [i, uri] of uris.entries()) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${path.basename(uri.fsPath)} (${i + 1}/${uris.length})`, increment: 100 / uris.length });
        try {
          if (await cleanFile(uri, server)) {
            changed++;
            // a file no editor showed is saved, as Visual Studio's cleanup writes it
            if (!open.has(uri.toString())) await (await vscode.workspace.openTextDocument(uri)).save();
          }
        } catch {
          // a file the server cannot answer for (not in a project) is left as it is
        }
      }
    });
    vscode.window.showInformationMessage(t('Code Cleanup: {0} of {1} C# files changed.', changed, uris.length));
  }));
}

module.exports = { registerCodeCleanup, rootsOf };
