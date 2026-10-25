// The UI's texts in English and Polish. t('English text {0}', arg) gives it in csharpShooter.uiLanguage ("auto": VS Code's
// display language), the Polish ones from l10n/pl.json (English text → Polish; Visual Studio's own Polish words where VS
// has the same thing). tn(n, 'one', 'many') adds Polish plurals: the entry for 'many' there is [one, few, many].
const vscode = require('vscode');
const pl = require('./l10n/pl.json');

function language() {
  const chosen = vscode.workspace.getConfiguration('csharpShooter').get('uiLanguage', 'auto');
  if (chosen === 'pl' || chosen === 'en') return chosen;
  return /^pl\b/i.test(vscode.env.language) ? 'pl' : 'en';
}

const fill = (text, args) => text.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));

function t(text, ...args) {
  return fill(language() === 'pl' && typeof pl[text] === 'string' ? pl[text] : text, args);
}

function tn(n, one, many, ...args) {
  if (language() !== 'pl' || !Array.isArray(pl[many])) return fill(n === 1 ? one : many, [n, ...args]);
  const [plOne, few, plMany] = pl[many];
  const form = n === 1 ? plOne : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : plMany;
  return fill(form, [n, ...args]);
}

/** A module's texts by name, each English text given in the UI's language as it is read; one with {0} becomes a
 *  function of its arguments. */
function table(texts) {
  const out = {};
  for (const [key, text] of Object.entries(texts)) {
    Object.defineProperty(out, key, { enumerable: true, get: () => (/\{\d\}/.test(text) ? (...args) => t(text, ...args) : t(text)) });
  }
  return out;
}

/** Marks an English text kept as it is and given to t() later (from a list), so test/l10n.js finds it. */
const n_ = (text) => text;

module.exports = { t, tn, n_, table, language };
