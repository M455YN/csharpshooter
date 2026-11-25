// A solution filter (.slnf) read as Visual Studio loads it: its solution's tree, with only the projects it lists.
//   node test/solution-filter.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// solution.js needs the editor's API only for its view, not for reading a solution
const stub = new Proxy(function () {}, { get: () => stub, construct: () => stub });
const load = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? stub : load(request, ...rest));
const { readSolution, baseSolution } = require('../solution');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slnf-'));
const project = (name, guid) => `Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "${name}", "src\\${name}\\${name}.csproj", "{${guid}}"\nEndProject\n`;
fs.writeFileSync(path.join(dir, 'Shop.sln'), [
  project('Web', '11111111-1111-1111-1111-111111111111'),
  project('Lib', '22222222-2222-2222-2222-222222222222'),
  'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "tests", "tests", "{33333333-3333-3333-3333-333333333333}"\nEndProject\n',
  project('Tests', '44444444-4444-4444-4444-444444444444'),
  'Global\n\tGlobalSection(NestedProjects) = preSolution\n\t\t{44444444-4444-4444-4444-444444444444} = {33333333-3333-3333-3333-333333333333}\n\tEndGlobalSection\nEndGlobal\n',
].join(''));
// as Visual Studio writes it: a byte order mark, backslashes
fs.writeFileSync(path.join(dir, 'Web.slnf'), `﻿${JSON.stringify({ solution: { path: 'Shop.sln', projects: ['src\\Web\\Web.csproj', 'src\\Lib\\Lib.csproj'] } }, null, 2)}`);

const tree = readSolution(path.join(dir, 'Web.slnf'));
assert.strictEqual(tree.name, 'Web');
assert.deepStrictEqual(tree.projects.map((p) => path.basename(p)), ['Web.csproj', 'Lib.csproj']);
assert.deepStrictEqual(tree.folders, [], 'a folder left with no project of the filter is not shown');
assert.strictEqual(baseSolution(path.join(dir, 'Web.slnf')), path.join(dir, 'Shop.sln'));
assert.strictEqual(baseSolution(path.join(dir, 'Shop.sln')), path.join(dir, 'Shop.sln'));
assert.strictEqual(readSolution(path.join(dir, 'Shop.sln')).folders[0].projects.length, 1, 'the solution itself is whole');
fs.rmSync(dir, { recursive: true, force: true });
console.log('solution filter: ok');
