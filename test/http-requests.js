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

// OpenAPI: a document as an ASP.NET Core app's MapOpenApi writes it (an enum as integers, a type that refers to itself,
// a oneOf), its operations written as requests, and responses held to its schemas.
const openApi = {
  openapi: '3.1.1',
  info: { title: 'Shop | v1', version: '1.0.0' },
  paths: {
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', format: 'int32' } }],
      get: { operationId: 'GetItem', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } },
      put: { operationId: 'PutItem', summary: 'Replaces an item', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } }, responses: { 204: { description: 'No Content' } } },
    },
    '/items': {
      get: { operationId: 'ListItems', parameters: [{ name: 'page', in: 'query', required: true, schema: { type: 'integer', default: 1 } }, { name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string', example: 'contoso' } }],
        responses: { '2XX': { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } } } } },
    },
    '/tree': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } },
    '/pets/{id}': {
      get: { operationId: 'GetPet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }] } } } } } },
    },
  },
  components: {
    schemas: {
      Item: { type: 'object', required: ['id', 'name', 'status'], properties: {
        id: { type: 'integer', readOnly: true }, name: { type: 'string' }, price: { type: ['number', 'null'] },
        status: { $ref: '#/components/schemas/Status' }, tags: { type: 'array', items: { type: 'string' } }, added: { type: 'string', format: 'date-time' } } },
      Status: { type: 'integer', enum: [1, 2, 3], description: 'Draft, Live, Gone' },
      Node: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }, parent: { $ref: '#/components/schemas/Node' } } },
      Cat: { type: 'object', required: ['meows'], properties: { meows: { type: 'boolean' } } },
      Dog: { type: 'object', required: ['barks'], properties: { barks: { type: 'boolean' } } },
    },
  },
};
const doc = h.openApiDocument(JSON.stringify(openApi));
assert.deepStrictEqual(doc.operations.map((o) => `${o.method} ${o.path}`), ['GET /items/{id}', 'PUT /items/{id}', 'GET /items', 'GET /tree', 'GET /pets/{id}']);
assert.equal(h.openApiDocument('{"paths":{}}'), null);
assert.equal(h.operationFor(doc, 'get', '/Items/42').operationId, 'GetItem');
assert.equal(h.operationFor(doc, 'GET', '/items/{{id}}').operationId, 'GetItem');
assert.equal(h.operationFor(doc, 'DELETE', '/items/42'), undefined);
// A sample: the enum as its first member's number, the read-only id left out, a type in itself null where it is met again.
assert.deepStrictEqual(h.sampleOf(doc, { $ref: '#/components/schemas/Item' }), { name: 'string', price: 0, status: 1, tags: ['string'], added: '2000-01-01T00:00:00Z' });
assert.deepStrictEqual(h.sampleOf(doc, { $ref: '#/components/schemas/Node' }), { name: 'string', children: [], parent: null });
assert.equal(h.sampleOf(doc, { type: 'integer', enum: ['2', '3'] }), 2);
assert.equal(h.sampleOf(doc, { type: 'string', enum: ['Draft', 'Live'] }), 'Draft');

const generated = h.openApiRequests(doc, '', 'baseUrl', 'http://localhost:5080');
assert.equal(generated.operations.length, 5);
const written = generated.text;
assert.ok(written.startsWith('@baseUrl = http://localhost:5080\n\n# OpenAPI: GetItem\n@id = 0\nGET {{baseUrl}}/items/{{id}}\nAccept: application/json\n\n###\n'), written);
assert.ok(written.includes('# OpenAPI: PutItem (Replaces an item)\nPUT {{baseUrl}}/items/{{id}}\nAccept: application/json\nContent-Type: application/json\n\n{\n  "name": "string",\n  "price": 0,\n  "status": 1,'), written);
assert.ok(written.includes('@page = 1\nGET {{baseUrl}}/items?page={{page}}\nAccept: application/json\nX-Tenant: contoso\n'), written);
// The pets' id is a GUID, not the items' 0: a variable of its own.
assert.ok(written.includes('@GetPet_id = 00000000-0000-0000-0000-000000000000\nGET {{baseUrl}}/pets/{{GetPet_id}}\n'), written);
const parsed = h.parse(written);
assert.deepStrictEqual(parsed.requests.map((r) => `${r.method} ${r.url}`), ['GET {{baseUrl}}/items/{{id}}', 'PUT {{baseUrl}}/items/{{id}}', 'GET {{baseUrl}}/items?page={{page}}', 'GET {{baseUrl}}/tree', 'GET {{baseUrl}}/pets/{{GetPet_id}}']);
assert.equal(JSON.parse(parsed.requests[1].body).status, 1);
assert.equal(h.prepare(parsed.requests[2], parsed.variables, {}, error).url, 'http://localhost:5080/items?page=1');
// Again over the file: nothing left to write; over a file calling two, the other three, the file's own @baseUrl kept.
assert.deepStrictEqual(h.openApiRequests(doc, written, 'baseUrl', 'http://localhost:5080'), { text: '', operations: [] });
const partial = '@baseUrl = http://localhost:1\n\nGET {{baseUrl}}/items/7\n\n###\nGET {{baseUrl}}/tree';
const more = h.openApiRequests(doc, partial, 'baseUrl', 'http://localhost:5080');
assert.deepStrictEqual(more.operations.map((o) => o.operationId || o.path), ['PutItem', 'ListItems', 'GetPet']);
assert.ok(more.text.startsWith('\n###\n\n# OpenAPI: PutItem') && !more.text.includes('@baseUrl'), more.text);
assert.equal(h.parse(partial + more.text).requests.length, 5);

// The check: what keeps to the schema says nothing; a missing required member, a wrong type, a member not in the enum,
// and a oneOf both or neither of whose options hold each say where.
const item = { $ref: '#/components/schemas/Item' };
assert.deepStrictEqual(h.checkSchema(doc, item, { id: 1, name: 'pen', price: null, status: 2, tags: [] }), []);
assert.deepStrictEqual(h.checkSchema(doc, item, { id: 1, price: '3', status: 7, tags: ['a', 5] }), [
  { at: '/name', said: 'is missing, though its schema requires it' },
  { at: '/price', said: 'number | null was expected, not "3"' },
  { at: '/status', said: '7 is not one of 1, 2, 3' },
  { at: '/tags/1', said: 'string was expected, not 5' },
]);
assert.deepStrictEqual(h.checkSchema(doc, { type: 'array', items: item }, [{ id: 1, name: 'a', status: 1 }, { id: 'x', name: 'b', status: 1 }]), [{ at: '/1/id', said: 'integer was expected, not "x"' }]);
const pet = doc.operations[4].responses[200];
assert.deepStrictEqual(h.checkSchema(doc, pet, { meows: true }), []);
assert.deepStrictEqual(h.checkSchema(doc, pet, { meows: true, barks: false }), [{ at: '/', said: "matches both Cat and Dog of its schema's oneOf, which allows exactly one" }]);
assert.deepStrictEqual(h.checkSchema(doc, pet, { purrs: true }), [{ at: '/', said: "matches none of the 2 options of its schema's oneOf" }]);
// A type in itself: its depths checked, and a schema that is only itself ends.
const tree = { name: 'root', children: [{ name: 'a', children: [{ children: [] }] }], parent: { name: 7 } };
assert.deepStrictEqual(h.checkSchema(doc, { $ref: '#/components/schemas/Node' }, tree), [
  { at: '/children/0/children/0/name', said: 'is missing, though its schema requires it' },
  { at: '/parent/name', said: 'string was expected, not 7' },
]);
const loops = h.openApiDocument({ openapi: '3.0.1', paths: {}, components: { schemas: { A: { allOf: [{ $ref: '#/components/schemas/A' }], oneOf: [{ $ref: '#/components/schemas/A' }] } } } });
assert.deepStrictEqual(h.checkSchema(loops, { $ref: '#/components/schemas/A' }, {}), []);
// A response: its operation found by its route, its status's schema (2XX here), JSON alone.
const json = (status, body) => ({ status, headers: [['Content-Type', 'application/json; charset=utf-8']], body: JSON.stringify(body) });
assert.deepStrictEqual(h.checkResponse(doc, 'GET', 'http://localhost:5080/items?page=1', json(200, [{ id: 1, status: 1 }])),
  { operation: 'GET /items', breaks: [{ at: '/0/name', said: 'is missing, though its schema requires it' }] });
assert.equal(h.checkResponse(doc, 'GET', 'http://localhost:5080/items/1', json(404, {})), null);
assert.equal(h.checkResponse(doc, 'GET', 'http://localhost:5080/items/1', { status: 200, headers: [['Content-Type', 'text/plain']], body: 'x' }), null);

// Where the document is read: the paths MapOpenApi is given, the build's file, the launch profiles' URLs.
assert.deepStrictEqual(h.mappedOpenApiPaths(['app.MapOpenApi("/docs/{documentName}.json");', 'app.MapOpenApi(pattern: "api.json")']), ['/docs/v1.json', '/api.json']);
const project = path.join(dir, 'Shop', 'Shop.csproj');
fs.mkdirSync(path.join(dir, 'Shop', 'obj'), { recursive: true });
fs.mkdirSync(path.join(dir, 'Shop', 'Properties'));
fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
assert.equal(h.openApiFromBuild(project), null);
fs.writeFileSync(path.join(dir, 'Shop', 'obj', 'Shop_internal.json'), JSON.stringify(openApi));
assert.equal(path.basename(h.openApiFromBuild(project).file), 'Shop_internal.json');
fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)\\docs</OpenApiDocumentsDirectory></PropertyGroup></Project>');
fs.mkdirSync(path.join(dir, 'Shop', 'docs'));
fs.writeFileSync(path.join(dir, 'Shop', 'docs', 'Shop.json'), JSON.stringify(openApi));
assert.equal(h.openApiFromBuild(project).file, path.join(dir, 'Shop', 'docs', 'Shop.json'));
fs.writeFileSync(path.join(dir, 'Shop', 'Properties', 'launchSettings.json'), '{ // as VS writes it\n "profiles": { "https": { "commandName": "Project", "applicationUrl": "https://localhost:7080;http://localhost:5080" }, "Docker": { "commandName": "Docker" }, } }');
assert.deepStrictEqual(h.launchUrls(project), ['http://localhost:5080', 'https://localhost:7080']);

(async () => {
  // The document asked of the app: its own path, a redirect within it followed, one away from it not.
  const app = http.createServer((req, res) => {
    if (req.url === '/docs/v1.json') return res.writeHead(302, { Location: '/openapi/v1.json' }).end();
    if (req.url === '/openapi/v1.json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(openApi));
    return res.writeHead(404).end();
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const fromApp = await h.openApiFromApp(origin, ['/docs/v1.json']);
  assert.equal(fromApp.url, `${origin}/openapi/v1.json`);
  assert.equal(fromApp.document.operations.length, 5);
  assert.equal(await h.openApiFromApp('http://example.org'), null);
  app.close();

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
