// Change Signature's text: a signature as one line to edit ("int Add(int a, ref string b = null)") and read back. No VS Code
// API here, so test/signature-text.js runs it on its own.

const parameterText = (p) => `${p.modifier ? `${p.modifier} ` : ''}${p.type} ${p.name}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`;

/** Splits at commas outside brackets and strings: "Dictionary<string, int> a, int b" is two. */
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** "int Add(int a, ref string b = null)" as its return type, name and parameters; null when it does not read as one.
 *  A constructor's has no return type: "Point(int x, int y)". */
function parseSignature(text, constructor) {
  const m = /^\s*(.*?)\s*\((.*)\)\s*$/s.exec(text);
  if (!m) return null;
  const head = m[1].trim().split(/\s+(?=[A-Za-z_@][\w]*$)/);
  const name = head.pop();
  if (!/^@?[A-Za-z_][\w]*$/.test(name || '')) return null;
  const returnType = constructor ? undefined : head.join(' ').trim();
  if (!constructor && !returnType) return null;
  const parameters = [];
  for (const raw of m[2].trim() ? splitTop(m[2], ',') : []) {
    const [decl, ...dflt] = splitTop(raw, '=');
    const words = decl.trim().split(/\s+/);
    if (words.length < 2) return null;
    const pname = words.pop();
    const modifiers = [];
    while (words.length > 1 && /^(ref|out|in|params|this|scoped|readonly)$/.test(words[0])) modifiers.push(words.shift());
    if (!/^@?[A-Za-z_][\w]*$/.test(pname)) return null;
    parameters.push({ modifier: modifiers.join(' '), type: words.join(' '), name: pname, defaultValue: dflt.join('=').trim() });
  }
  return { returnType, name, parameters };
}

module.exports = { parameterText, parseSignature, splitTop };
