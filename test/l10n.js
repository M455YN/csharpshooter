// Every English text of the UI has its Polish in l10n/pl.json, and pl.json has no text the code no longer says:
//   node test/l10n.js
// The texts are t('…') and tn(n, '…', '…') calls and the entries of table({ … }), read from the extension's sources.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pl = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'pl.json'), 'utf8'));
const literal = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`;
const unquote = (m) => JSON.parse(`"${(m[1] ?? m[2]).replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"`);
const used = new Map(); // text -> where
const plurals = new Set();
for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.js') && f !== 'l10n.js')) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const m of source.matchAll(new RegExp(String.raw`\b(?:t|n_)\(\s*(?:${literal})`, 'g'))) used.set(unquote(m), file);
  for (const m of source.matchAll(new RegExp(String.raw`\btn\([^,]+,\s*(?:${literal})\s*,\s*(?:${literal})`, 'g'))) {
    const many = unquote([, m[3], m[4]]);
    used.set(many, file);
    plurals.add(many);
  }
  for (const body of source.matchAll(/\btable\(\{([\s\S]*?)\}\);/g)) {
    for (const m of body[1].matchAll(new RegExp(String.raw`:\s*(?:${literal})`, 'g'))) used.set(unquote(m), file);
  }
}
const problems = [];
for (const [text, file] of used) {
  if (!(text in pl)) problems.push(`${file}: no Polish for ${JSON.stringify(text)}`);
  else if (plurals.has(text) !== Array.isArray(pl[text])) problems.push(`${file}: ${JSON.stringify(text)} wants ${plurals.has(text) ? 'three plural forms' : 'one text'}`);
}
for (const text of Object.keys(pl)) if (!used.has(text)) problems.push(`l10n/pl.json: ${JSON.stringify(text)} is not in the code`);
for (const [text, polish] of Object.entries(pl)) {
  const holes = (s) => [...s.matchAll(/\{\d\}/g)].map((m) => m[0]).sort().join();
  for (const p of [].concat(polish)) if (holes(p) !== holes(text)) problems.push(`l10n/pl.json: ${JSON.stringify(p)} has other {n} than ${JSON.stringify(text)}`);
}
// package.json's texts: each %key% in package.nls.json (English) and package.nls.pl.json (Polish), and nothing more.
const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const refs = new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
for (const name of ['package.nls.json', 'package.nls.pl.json']) {
  const nls = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  for (const key of refs) if (!(key in nls)) problems.push(`${name}: no "${key}"`);
  for (const key of Object.keys(nls)) if (!refs.has(key)) problems.push(`${name}: "${key}" is not in package.json`);
}
console.log(problems.length ? problems.join('\n') : `${used.size} texts and ${refs.size} of package.json's, each with its Polish`);
process.exitCode = problems.length ? 1 : 0;
