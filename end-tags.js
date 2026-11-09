// Typing a start tag's '>' writes its end tag after the caret, as Visual Studio does, in a .razor/.cshtml and in XML (project
// files, .props, .targets): a step of Undo of its own, the caret left between the tags. A Razor file's end tag is Razor's
// own answer to the '>' (the server's _vs_onAutoInsert, as VS asks it): Razor reads the file as it compiles it, so a void
// element, a self-closing tag, a component that takes no content and a generic's '<' in C# are told apart. An XML file's is
// read from its text. The end tag lands where the '>' was typed, carried through what was typed since, however fast: keys
// typed while it was worked out stay before it. Razor's linked editing ranges (renaming a tag's pair) are not this: the
// server's HTML half has no server of its own here, so they stay unanswered (extension.js).
// HTML files are VS Code's own HTML extension's (html.autoClosingTags).
const vscode = require('vscode');

/** Where an end tag goes in a document, carried through its changes: after the '>' at `gt` and what was typed after it
 *  since (the caret stood there). A change of the '>' itself, or over the place, loses it. */
class Place {
  constructor(document, gt) {
    this.document = document;
    this.gt = gt;
    this.offset = gt + 1;
    this.lost = false;
  }

  carry(changes) {
    for (const c of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      const end = c.rangeOffset + c.rangeLength;
      const moved = c.text.length - c.rangeLength;
      if (end <= this.gt) this.gt += moved;
      else if (c.rangeOffset <= this.gt) this.lost = true;
      if (end < this.offset || (end === this.offset && (c.rangeLength > 0 || c.rangeOffset === this.offset))) this.offset += moved;
      else if (c.rangeOffset < this.offset) this.lost = true;
    }
  }
}

/** The name of the start tag a '>' at `gt` ends in XML; null where it ends none (a value's '>', a comment, '/>', '?>'). */
function xmlStartTag(text, gt) {
  if (text[gt - 1] === '/') return null;
  const lt = text.lastIndexOf('<', gt);
  if (lt < 0 || text.lastIndexOf('<!--', gt) > text.lastIndexOf('-->', gt)) return null;
  const m = /^<([A-Za-z_][\w:.-]*)(?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*$/.exec(text.slice(lt, gt));
  return m ? m[1] : null;
}

/** Whether an end tag after `from` closes the element `name` just started: read on, the elements started after it paired with
 *  their end tags, its own comes before an end tag of an element holding it. */
function closedAfter(text, from, name) {
  const open = [];
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g;
  tags.lastIndex = from;
  for (let m; (m = tags.exec(text));) {
    if (!m[2] || m[3]) continue;
    if (!m[1]) open.push(m[2]);
    else if (open.length && open.at(-1) === m[2]) open.pop();
    else return !open.length && m[2] === name;
  }
  return false;
}

/** An XML file's end tag for the '>' just before `caret`; null for none. */
function xmlEndTag(text, caret) {
  const name = xmlStartTag(text, caret - 1);
  return name && !closedAfter(text, caret, name) ? { text: `</${name}>`, name } : null;
}

const isXml = (document) => document.languageId === 'xml' || /\.(csproj|vbproj|fsproj|proj|props|targets)$/i.test(document.fileName);

function registerEndTags(context, server) {
  const places = new Set();
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    for (const place of places) if (place.document === e.document) place.carry(e.contentChanges);
    const [change] = e.contentChanges;
    const editor = vscode.window.activeTextEditor;
    if (e.contentChanges.length !== 1 || change.text !== '>' || change.rangeLength !== 0 || editor?.document !== e.document
      || editor.selections.length !== 1 || e.reason) return;
    const razor = e.document.languageId === 'aspnetcorerazor';
    if (!razor && !isXml(e.document)) return;
    const caret = change.rangeOffset + 1;
    const place = new Place(e.document, change.rangeOffset);
    places.add(place);
    const closing = razor
      // Razor's answer for the text with the '>': asked once the language client has passed the change on.
      ? new Promise((r) => setTimeout(r, 0)).then(() => razorEndTag(server, place, { version: e.document.version, position: e.document.positionAt(caret), options: editor.options }))
      : Promise.resolve(xmlEndTag(e.document.getText(), caret));
    closing.then((edit) => edit && close(place, edit)).catch(() => {}).finally(() => places.delete(place));
  }));
}

/** Razor's end tag for the '>' it was asked about: { text, name } for one written at the caret; { snippet, range, version }
 *  for another edit (a component closed in itself, its '>' replaced), made only on the text it was worked out for. */
async function razorEndTag(server, place, asked) {
  const s = server();
  if (!s) return null;
  const answer = await s.client.sendRequest('textDocument/_vs_onAutoInsert', {
    _vs_textDocument: { uri: s.toServerUri(place.document.uri) },
    _vs_position: { line: asked.position.line, character: asked.position.character },
    _vs_ch: '>',
    _vs_options: { tabSize: Number(asked.options.tabSize) || 4, insertSpaces: asked.options.insertSpaces !== false },
  }).catch(() => null);
  const edit = answer?._vs_textEdit;
  if (!edit) return null;
  const { start, end } = edit.range;
  const snippet = answer._vs_textEditFormat === 2 ? edit.newText : new vscode.SnippetString().appendText(edit.newText).value;
  const atCaret = start.line === end.line && start.character === end.character && start.line === asked.position.line && start.character === asked.position.character;
  // An end tag at the caret, the caret before it: "$0</div>", or the end tag alone.
  const endTag = /^(?:\$0|\$\{0\})?((?:[^$\\]|\\[$}\\])*)$/.exec(snippet);
  if (atCaret && endTag) {
    const text = endTag[1].replace(/\\([$}\\])/g, '$1');
    return { text, name: /<\/([^>\s]+)>/.exec(text)?.[1] };
  }
  return { snippet: new vscode.SnippetString(snippet), range: new vscode.Range(start.line, start.character, end.line, end.character), version: asked.version };
}

/** Writes the end tag at the place, once the editor has the text the extension has: VS Code refuses a write against an
 *  older text, and it is tried again with the place carried on. Not where the end tag was typed by hand since the '>'. */
async function close(place, edit) {
  for (let tries = 0; tries < 50 && !place.lost; tries++) {
    await new Promise((r) => setTimeout(r, tries ? 10 : 0));
    const document = place.document;
    if (place.lost || document.isClosed) return;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
    if (edit.snippet) {
      if (editor && document.version === edit.version) await editor.insertSnippet(edit.snippet, edit.range, { undoStopBefore: true, undoStopAfter: true });
      return;
    }
    const text = document.getText();
    if (edit.name && text.slice(place.gt + 1, place.offset).includes(`</${edit.name}`)) return;
    const at = document.positionAt(place.offset);
    let done;
    if (editor) {
      // Written over the character after the caret, which it writes again after the tag: the caret, at the start of what
      // was replaced, stays before the end tag (an insertion at the caret, or a snippet's, would put it after).
      const next = text.slice(place.offset, place.offset + (/[\r\uD800-\uDBFF]/.test(text[place.offset] ?? '') ? 2 : 1));
      const range = new vscode.Range(at, document.positionAt(place.offset + next.length));
      done = await editor.edit((b) => b.replace(range, edit.text + next), { undoStopBefore: true, undoStopAfter: true });
    } else {
      const write = new vscode.WorkspaceEdit();
      write.insert(document.uri, at, edit.text);
      done = await vscode.workspace.applyEdit(write);
    }
    if (done) return;
  }
}

module.exports = { registerEndTags, xmlEndTag };
