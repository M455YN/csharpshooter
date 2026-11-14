// Values after the lines at a stop, as Visual Studio shows them while debugging: for each line of the stopped method up
// to the stop, the locals and parameters it names, which VS Code looks up in the debugger's scopes and shows after the
// line (debug.inlineValues). A name that is no variable there (a type, a member) shows nothing.
const vscode = require('vscode');
const { on } = require('./features');

const KEYWORDS = new Set(('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double '
  + 'else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long '
  + 'namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof '
  + 'stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile '
  + 'while add and alias ascending async await by descending dynamic equals from get global group init into join let managed nameof '
  + 'nint not notnull nuint on or orderby partial record remove required scoped select set unmanaged value var when where with yield '
  + 'file args').split(' '));

/** The lines with comments, strings and characters blanked (their length kept), from a block comment open before them. */
function codeOf(lines) {
  let inComment = false;
  return lines.map((line) => {
    let out = '';
    for (let i = 0; i < line.length;) {
      if (inComment) {
        const end = line.indexOf('*/', i);
        const stop = end < 0 ? line.length : end + 2;
        out += ' '.repeat(stop - i);
        i = stop;
        inComment = end < 0;
      } else if (line.startsWith('//', i)) {
        out += ' '.repeat(line.length - i);
        i = line.length;
      } else if (line.startsWith('/*', i)) {
        inComment = true;
      } else if (line[i] === '"' || line[i] === "'" || ((line[i] === '@' || line[i] === '$') && /^[@$]{1,2}"/.test(line.slice(i)))) {
        // shortcut: an interpolated string's holes are blanked with it, and a verbatim string over lines ends at its line
        const open = line.slice(i).match(/^[@$]*["']/)[0];
        const quote = open.at(-1);
        const verbatim = open.includes('@');
        let j = i + open.length;
        while (j < line.length) {
          if (!verbatim && line[j] === '\\') j += 2;
          else if (line[j] === quote && verbatim && line[j + 1] === quote) j += 2;
          else if (line[j] === quote) break;
          else j++;
        }
        const stop = Math.min(line.length, j + 1);
        out += ' '.repeat(stop - i);
        i = stop;
      } else {
        out += line[i];
        i++;
      }
    }
    return out;
  });
}

/** The names on each line that may be a local or a parameter: { line (index into lines), start, end, name }, once a line,
 *  never a keyword, a member after a dot, or a method called. */
function inlineNames(lines) {
  const found = [];
  codeOf(lines).forEach((code, line) => {
    const seen = new Set();
    for (const m of code.matchAll(/(?<![\w.$#])@?[A-Za-z_]\w*/g)) {
      const name = m[0].replace(/^@/, '');
      const after = code.slice(m.index + m[0].length);
      // @class is a variable named class, never the keyword
      if ((m[0][0] !== '@' && KEYWORDS.has(name)) || seen.has(name) || /^\s*(\(|<[\w\s,.<>?]*>\s*\()/.test(after)) continue;
      seen.add(name);
      found.push({ line, start: m.index, end: m.index + m[0].length, name });
    }
  });
  return found;
}

const BODIES = new Set([vscode.SymbolKind?.Method, vscode.SymbolKind?.Constructor, vscode.SymbolKind?.Function, vscode.SymbolKind?.Property, vscode.SymbolKind?.Operator]);

/** The innermost method, constructor, accessor or local function holding the line, from the document's symbols. */
function enclosing(symbols, line) {
  let best;
  const walk = (list) => {
    for (const s of list || []) {
      const range = s.range || s.location?.range;
      if (!range || range.start.line > line || range.end.line < line) continue;
      if (BODIES.has(s.kind)) best = range;
      walk(s.children);
    }
  };
  walk(symbols);
  return best;
}

function registerInlineValues(context) {
  context.subscriptions.push(vscode.languages.registerInlineValuesProvider({ language: 'csharp' }, {
    async provideInlineValues(document, viewPort, stop) {
      if (!on('inlineValues')) return [];
      const stopLine = stop.stoppedLocation.end.line;
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri).then((s) => s, () => undefined);
      const body = enclosing(symbols, stopLine);
      // shortcut: without the server's symbols, the 30 lines above the stop; enough until the symbols come
      const first = Math.max(body ? body.start.line : stopLine - 30, viewPort.start.line, stopLine - 500);
      if (first > stopLine) return [];
      const lines = [];
      for (let l = first; l <= stopLine; l++) lines.push(document.lineAt(l).text);
      return inlineNames(lines).map((n) => new vscode.InlineValueVariableLookup(new vscode.Range(first + n.line, n.start, first + n.line, n.end), n.name, true));
    },
  }));
}

module.exports = { registerInlineValues, inlineNames, codeOf };
