// Inline values: the names of a method's lines that may be locals or parameters, as the debugger is asked for them.
//   node test/inline-values.js
const assert = require('assert');
const Module = require('module');
const load = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? { SymbolKind: {} } : load(request, ...rest));
const { inlineNames, codeOf } = require('../inline-values');

const names = (lines) => inlineNames(lines).map((n) => `${n.line}:${n.name}`);

// locals and parameters, once a line; no keyword, member after a dot, method called or generic call
assert.deepStrictEqual(names([
  'public int Sum(int[] items, int start)',
  '{',
  '    var total = start + items.Length;',
  '    foreach (var item in items) total += Math.Max(item, 0);',
  '    var list = Enumerable.Repeat<int>(total, 2).ToList();',
  '    return total;',
]), ['0:items', '0:start', '2:total', '2:start', '2:items', '3:item', '3:items', '3:total', '3:Math', '4:list', '4:Enumerable', '4:total', '5:total']);

// comments, strings, characters and verbatim strings say no name; a block comment goes on over lines
const blanked = ['var a = "b c"; // d', 'var e = @"f ""g"""; /* h', 'i */ var j = \'k\';'];
assert.deepStrictEqual(codeOf(blanked).map((l, i) => [l.length === blanked[i].length, l.replace(/\s+/g, ' ').trim()]),
  [[true, 'var a = ;'], [true, 'var e = ;'], [true, 'var j = ;']]);
assert.deepStrictEqual(names(['var s = $"{x} y"; // z', '/* w */ var v = s;']), ['0:s', '1:v', '1:s']);

// an @-escaped name is looked up without its @
assert.deepStrictEqual(inlineNames(['var @class = 1;']).map((n) => [n.name, n.start, n.end]), [['class', 4, 10]]);

console.log('inline-values: ok');
