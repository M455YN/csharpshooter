// The HTTPS development certificate's check before F5, with dotnet dev-certs stubbed: what it runs and asks for each
// state the certificate can be in, as Visual Studio 2026 does.
//   node test/dev-certs.js
const assert = require('assert');
const d = require('../dev-certs');

async function scenario(name, codes, answer) {
  d.reset();
  const ran = [];
  const asked = [];
  const failed = [];
  const result = await d.ensureTrusted({
    dotnet: async (args) => {
      ran.push(args.join(' ') || '(install)');
      return codes[ran.length - 1] ?? 0;
    },
    ask: async () => (asked.push(true), answer),
    fail: (code) => failed.push(code),
  });
  console.log(`${name}: ${result}; ran ${ran.join(', ')}; asked ${asked.length}; failed ${failed.join(',') || '-'}`);
  return { result, ran, asked: asked.length, failed };
}

(async () => {
  let r = await scenario('trusted', [0], 'yes');
  assert.deepStrictEqual([r.result, r.ran, r.asked], ['trusted', ['--trust --check'], 0]);

  r = await scenario('not trusted, yes', [d.NOT_TRUSTED, 0], 'yes');
  assert.deepStrictEqual([r.result, r.ran, r.asked], ['trusted', ['--trust --check', '--trust'], 1]);

  r = await scenario('not trusted, no', [d.NOT_TRUSTED], 'no');
  assert.deepStrictEqual([r.result, r.ran], ['no', ['--trust --check']]);

  r = await scenario('none, installed, then trusted', [d.NO_CERTIFICATE, 0, 0], 'yes');
  assert.deepStrictEqual([r.result, r.ran], ['trusted', ['--trust --check', '(install)', '--trust']]);

  r = await scenario('install fails', [d.NO_CERTIFICATE, 1], 'yes');
  assert.deepStrictEqual([r.result, r.asked, r.failed], ['failed', 0, [1]]);

  r = await scenario('Windows prompt cancelled', [d.NOT_TRUSTED, 5], 'yes');
  assert.deepStrictEqual([r.result, r.failed], ['failed', []]);

  r = await scenario('dotnet missing', [-1], 'yes');
  assert.deepStrictEqual([r.result, r.asked, r.failed], ['failed', 0, [-1]]);

  d.reset();
  const refused = await d.ensureTrusted({ dotnet: async () => d.NOT_TRUSTED, ask: async () => { throw new Error('refused to show dialog'); }, fail: () => {} });
  assert.strictEqual(refused, 'no');

  // Once a window session: a second F5 runs nothing.
  const ran = [];
  const again = await d.ensureTrusted({ dotnet: async (a) => (ran.push(a), 0), ask: async () => 'yes', fail: () => {} });
  assert.deepStrictEqual([again, ran.length], ['checked', 0]);

  console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
