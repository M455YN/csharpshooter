// Change Signature's one-line text read back: return type, name and parameters, generics and defaults with commas kept.
//   node test/signature-text.js
const assert = require('assert');
const { parseSignature, parameterText } = require('../signature-text');

assert.deepStrictEqual(parseSignature('double Area(double scale, int times)', false), {
  returnType: 'double', name: 'Area',
  parameters: [{ modifier: '', type: 'double', name: 'scale', defaultValue: '' }, { modifier: '', type: 'int', name: 'times', defaultValue: '' }],
});
assert.deepStrictEqual(parseSignature('Dictionary<string, List<int>> Map(ref Dictionary<string, int> a, string b = "x, y", params int[] rest)', false), {
  returnType: 'Dictionary<string, List<int>>', name: 'Map',
  parameters: [
    { modifier: 'ref', type: 'Dictionary<string, int>', name: 'a', defaultValue: '' },
    { modifier: '', type: 'string', name: 'b', defaultValue: '"x, y"' },
    { modifier: 'params', type: 'int[]', name: 'rest', defaultValue: '' },
  ],
});
assert.deepStrictEqual(parseSignature('Point(int x, int y = 0)', true), {
  returnType: undefined, name: 'Point',
  parameters: [{ modifier: '', type: 'int', name: 'x', defaultValue: '' }, { modifier: '', type: 'int', name: 'y', defaultValue: '0' }],
});
assert.deepStrictEqual(parseSignature('void Run()', false).parameters, []);
assert.deepStrictEqual(parseSignature('Task<int> GetAsync(this IService s, CancellationToken cancel = default)', false).parameters[0],
  { modifier: 'this', type: 'IService', name: 's', defaultValue: '' });
// Not a signature: no parentheses, no return type for a method, a parameter with no name.
assert.strictEqual(parseSignature('double Area', false), null);
assert.strictEqual(parseSignature('Area(int a)', false), null);
assert.strictEqual(parseSignature('void Run(int)', false), null);
assert.strictEqual(parameterText({ modifier: 'ref', type: 'int', name: 'a', defaultValue: '' }), 'ref int a');
assert.strictEqual(parameterText({ modifier: '', type: 'string', name: 'b', defaultValue: '"x"' }), 'string b = "x"');
console.log('signature text: all passed');
