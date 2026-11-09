// Attach to Process: a program's name as listed, and Reattach's choice of the process last attached to.
//   node test/attach.js
const assert = require('assert');
const Module = require('module');
const load = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? {} : load(request, ...rest));
const { programName, reattachCandidates, listProcesses } = require('../attach');

assert.strictEqual(programName('Shop.Api.exe', 'C:\\app\\Shop.Api.exe'), 'Shop.Api');
assert.strictEqual(programName('dotnet.exe', '"C:\\Program Files\\dotnet\\dotnet.exe" "C:\\my app\\Shop.Api.dll" --urls x'), 'Shop.Api');
assert.strictEqual(programName('dotnet.exe', 'dotnet exec --depsfile a.deps.json bin/Web.dll'), 'Web');
assert.strictEqual(programName('dotnet.exe', 'dotnet build'), 'dotnet');

const p = (id, name, commandLine) => ({ id, name, commandLine });
const last = p(10, 'App.exe', 'App.exe --a');
assert.deepStrictEqual(reattachCandidates([p(10, 'App.exe', 'App.exe --a'), p(11, 'App.exe', 'App.exe --a')], last).map((x) => x.id), [10]);
assert.deepStrictEqual(reattachCandidates([p(12, 'App.exe', 'App.exe --a'), p(13, 'App.exe', 'App.exe --b')], last).map((x) => x.id), [12]);
assert.deepStrictEqual(reattachCandidates([p(13, 'App.exe', 'App.exe --b'), p(14, 'App.exe', '')], last).map((x) => x.id), [13, 14]);
assert.deepStrictEqual(reattachCandidates([p(15, 'Other.exe', 'Other.exe')], last), []);

listProcesses().then((found) => {
  assert.ok(Array.isArray(found));
  for (const f of found) assert.ok(f.id > 0 && f.name && f.program !== undefined);
  console.log(`attach: ok (${found.length} .NET processes now: ${found.map((f) => `${f.program} ${f.id}`).join(', ') || 'none'})`);
});
