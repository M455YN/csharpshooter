// Doc comments as Visual Studio writes them: a third '/' typed alone on a line above a member writes its template (a
// <summary>, a <param> for each parameter, its <returns>, the caret in the summary), and Enter inside one carries the
// "/// " on. Both are the C# server's own answers to them (_vs_onAutoInsert, as VS asks it), one step of Undo with what
// was typed.
const vscode = require('vscode');
const { on } = require('./features');

/** What was just typed that the server may answer: '/' making a line of "///" alone, or a line break after a "///" line. */
function trigger(document, change) {
  if (change.rangeLength !== 0) return undefined;
  const end = document.positionAt(change.rangeOffset + change.text.length);
  if (change.text === '/') {
    return /^\s*\/\/\/$/.test(document.lineAt(end.line).text.slice(0, end.character)) ? { ch: '/', position: end } : undefined;
  }
  if (/^\r?\n[ \t]*$/.test(change.text) && end.line > 0 && /^\s*\/\/\//.test(document.lineAt(end.line - 1).text)) return { ch: '\n', position: end };
  return undefined;
}

function registerDocComments(context, server) {
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId !== 'csharp' || e.reason || e.contentChanges.length !== 1 || !on('docComments')) return;
    const editor = vscode.window.activeTextEditor;
    if (editor?.document !== e.document || editor.selections.length !== 1) return;
    const asked = trigger(e.document, e.contentChanges[0]);
    // asked once the language client has passed the change on to the server
    if (asked) setTimeout(() => answer(server, editor, asked, e.document.version).catch(() => {}), 0);
  }));
}

async function answer(server, editor, { ch, position }, version) {
  const s = server();
  if (!s) return;
  const document = editor.document;
  const got = await s.client.sendRequest('textDocument/_vs_onAutoInsert', {
    _vs_textDocument: { uri: s.toServerUri(document.uri) },
    _vs_position: { line: position.line, character: position.character },
    _vs_ch: ch,
    _vs_options: { tabSize: Number(editor.options.tabSize) || 4, insertSpaces: editor.options.insertSpaces !== false },
  });
  const edit = got?._vs_textEdit;
  // Only on the text it was worked out for: anything typed meanwhile wins.
  if (!edit || document.isClosed || document.version !== version) return;
  const snippet = got._vs_textEditFormat === 2 ? new vscode.SnippetString(edit.newText) : new vscode.SnippetString().appendText(edit.newText);
  const { start, end } = edit.range;
  await editor.insertSnippet(snippet, new vscode.Range(start.line, start.character, end.line, end.character), { undoStopBefore: false, undoStopAfter: true });
}

module.exports = { registerDocComments, trigger };
