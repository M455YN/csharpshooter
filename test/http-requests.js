// .http files, without an editor: their requests, variables and environments, sent to a server of the test's own.
//   node test/http-requests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('../http-requests');

const error = { undefined: (n) => `undefined ${n}`, notAbsolute: (u) => `not absolute ${u}` };
const text = [
  '@host = http://127.0.0.1:{{port}}',
  '@id = 42',
  '',
  '# the first',
  'GET {{host}}/items/{{id}} HTTP/1.1',
  'Accept: application/json',
  '',
  '###',
  '',
  '// a second, with a body',
  'POST {{host}}/items',
  'Content-Type: application/json',
  'X-Token: {{token}}',
  '',
  '{ "name": "{{$guid}}" }',
  '',
  '###',
  'https://example.org/plain',
].join('\r\n');
const { requests, variables } = h.parse(text);
assert.deepStrictEqual(requests.map((r) => [r.line, r.method, r.url]), [[4, 'GET', '{{host}}/items/{{id}}'], [10, 'POST', '{{host}}/items'], [17, 'GET', 'https://example.org/plain']]);
assert.deepStrictEqual(requests[0].headers, [['Accept', 'application/json']]);
assert.deepStrictEqual(requests[1].headers.map((x) => x[0]), ['Content-Type', 'X-Token']);
assert.equal(requests[1].body, '{ "name": "{{$guid}}" }');
assert.deepStrictEqual([...variables.keys()], ['host', 'id']);

// Environments: http-client.env.json and its .user beside it, $shared under each.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-http-'));
fs.mkdirSync(path.join(dir, 'api'));
fs.writeFileSync(path.join(dir, 'http-client.env.json'), JSON.stringify({ $shared: { token: 'shared' }, dev: { port: '1' }, prod: { port: '2', token: 'prod' } }));
fs.writeFileSync(path.join(dir, 'http-client.env.json.user'), JSON.stringify({ dev: { token: 'mine' } }));
const env = h.environments(path.join(dir, 'api', 'requests.http'), dir);
assert.deepStrictEqual(Object.keys(env.all), ['dev', 'prod']);
assert.deepStrictEqual(env.all.dev, { token: 'mine', port: '1' });
assert.equal(env.all.prod.token, 'prod');
assert.throws(() => h.prepare(requests[0], variables, {}, error), /undefined port/);
assert.throws(() => h.prepare({ method: 'GET', url: 'items/1', headers: [], body: '' }, new Map(), {}, error), /not absolute items\/1/);

(async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, token: req.headers['x-token'] || null, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const environment = { port: String(server.address().port), token: 'abc' };
  const got = await h.send(h.prepare(requests[0], variables, environment, error));
  assert.equal(got.status, 200);
  assert.deepStrictEqual(JSON.parse(got.body), { method: 'GET', url: '/items/42', token: null, body: '' });
  const posted = h.prepare(requests[1], variables, environment, error);
  const sent = await h.send(posted);
  const answer = JSON.parse(sent.body);
  assert.equal(answer.token, 'abc');
  assert.match(JSON.parse(answer.body).name, /^[0-9a-f-]{36}$/);
  assert.ok(sent.bytes > 0 && sent.ms >= 0);
  const raw = h.raw(posted, sent, { request: '=== ŻĄDANIE ===', response: '=== ODPOWIEDŹ ===' });
  assert.ok(raw.startsWith(`=== ŻĄDANIE ===\nPOST http://127.0.0.1:${environment.port}/items\nContent-Type: application/json`) && raw.includes('=== ODPOWIEDŹ ===\nHTTP 200 OK'), raw);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('http-requests: ok');
})().catch((e) => { console.error(e); process.exit(1); });
