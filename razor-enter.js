// Enter among a tag's attributes in a .cshtml/.razor opens Razor's list of them, as a space there does: space is one of
// Razor's trigger characters, a new line is not, so VS Code waited for a letter. Razor is asked as for a space at the new
// line; only where it answers (inside a tag, not in markup or C#, where it gives nothing) is the list opened.
const vscode = require('vscode');

const { Text, Snippet } = vscode.CompletionItemKind;

function registerRazorEnter(context) {
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (e) => {
    const editor = vscode.window.activeTextEditor;
    const [change] = e.contentChanges;
    if (e.document.languageId !== 'aspnetcorerazor' || editor?.document !== e.document || e.contentChanges.length !== 1
      || editor.selections.length !== 1 || !/^\r?\n[ \t]*$/.test(change.text)) return;
    const version = e.document.version;
    const at = new vscode.Position(change.range.start.line + 1, change.text.replace(/^\r?\n/, '').length);
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', e.document.uri, at, ' ');
    // Words of the document and snippets come from VS Code itself, wherever the cursor is.
    if (e.document.version !== version || !editor.selection.active.isEqual(at) || !list?.items.some((i) => i.kind !== Text && i.kind !== Snippet)) return;
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
  }));
}

module.exports = { registerRazorEnter };
