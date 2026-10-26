// The Configuration Manager's reading and writing of .sln and .slnx, without an editor: node test/solution-config.js
// Each .slnx is also checked against Microsoft's own library: the same matrix written as an .sln and migrated by
// `dotnet sln migrate` (vs-solutionpersistence) must give the rules written here (skipped where dotnet is not installed).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const c = require('../solution-config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-sln-'));
const slnx = [
  '<Solution>',
  '  <Configurations>',
  '    <BuildType Name="Debug" />',
  '    <BuildType Name="debug web" />',
  '    <BuildType Name="Release" />',
  '    <Platform Name="Any CPU" />',
  '    <Platform Name="x64" />',
  '    <Platform Name="x86" />',
  '  </Configurations>',
  '  <Project Path="Core/Core.csproj">',
  '    <BuildType Solution="debug web|Any CPU" Project="Debug" />',
  '  </Project>',
  '  <Project Path="Schema/Schema.csproj">',
  '    <BuildType Solution="debug web|*" Project="Debug" />',
  '  </Project>',
  '  <Project Path="Web/Web.csproj">',
  '    <BuildDependency Project="Core/Core.csproj" />',
  '    <BuildType Solution="debug web|Any CPU" Project="Debug" />',
  '    <Build Solution="debug web|Any CPU" Project="false" />',
  '  </Project>',
  '  <Project Path="Tool/Tool.csproj" />',
  '</Solution>',
  '',
].join('\r\n');
const file = path.join(dir, 'App.slnx');
fs.writeFileSync(file, slnx);

// Read: the matrix the rules make, and the same file written back.
let s = c.read(file);
assert.deepStrictEqual(s.buildTypes, ['Debug', 'debug web', 'Release']);
assert.deepStrictEqual(s.platforms, ['Any CPU', 'x64', 'x86']);
const at = (name, bt, pl) => s.projects.find((p) => p.path.startsWith(name)).cells.get(c.key(bt, pl));
assert.deepStrictEqual(at('Core', 'debug web', 'Any CPU'), { buildType: 'Debug', platform: 'AnyCPU', build: true, deploy: false });
assert.deepStrictEqual(at('Core', 'debug web', 'x64'), { buildType: 'debug web', platform: 'AnyCPU', build: true, deploy: false });
assert.equal(at('Schema', 'debug web', 'x86').buildType, 'Debug');
assert.equal(at('Web', 'debug web', 'Any CPU').build, false);
assert.equal(c.write(s), slnx);

// Changes, each giving the fewest rules, in place, the project's other children kept.
const web = s.projects.find((p) => p.path.startsWith('Web'));
const tool = s.projects.find((p) => p.path.startsWith('Tool'));
for (const bt of s.buildTypes) for (const pl of s.platforms) tool.cells.get(c.key(bt, pl)).build = false;
web.cells.get(c.key('Release', 'x64')).deploy = true;
let text = c.write(s);
assert.ok(text.includes('  <Project Path="Tool/Tool.csproj">\r\n    <Build Project="false" />\r\n  </Project>'), text);
assert.ok(text.includes('    <BuildDependency Project="Core/Core.csproj" />\r\n    <BuildType Solution="debug web|Any CPU" Project="Debug" />\r\n    <Build Solution="debug web|Any CPU" Project="false" />\r\n    <Deploy Solution="Release|x64" />\r\n  </Project>'), text);
for (const bt of s.buildTypes) for (const pl of s.platforms) tool.cells.get(c.key(bt, pl)).build = true;
web.cells.get(c.key('Release', 'x64')).deploy = false;
assert.equal(c.write(s), slnx);

// A new solution configuration copied from Debug, renamed, then removed; a new platform; back to the start.
c.addSolution(s, 'buildTypes', 'Staging', 'Debug');
assert.deepStrictEqual(s.buildTypes, ['Debug', 'debug web', 'Release', 'Staging']);
assert.equal(at('Core', 'Staging', 'x64').buildType, 'Debug');
text = c.write(s);
assert.ok(text.includes('    <BuildType Name="Staging" />\r\n    <Platform Name="Any CPU" />'));
assert.ok(text.includes('<BuildType Solution="Staging|*" Project="Debug" />'), text);
c.renameSolution(s, 'buildTypes', 'Staging', 'Test');
assert.ok(c.write(s).includes('<BuildType Solution="Test|*" Project="Debug" />'));
c.removeSolution(s, 'buildTypes', 'Test');
c.addSolution(s, 'platforms', 'ARM64', null);
assert.equal(at('Core', 'Debug', 'ARM64').platform, 'AnyCPU');
c.removeSolution(s, 'platforms', 'ARM64');
assert.equal(c.write(s), slnx);

// The default configurations leave <Configurations> out, and a project with no rules is written self-closed.
const plain = path.join(dir, 'Plain.slnx');
fs.writeFileSync(plain, '<Solution>\n  <Project Path="A/A.csproj" />\n</Solution>\n');
s = c.read(plain);
assert.deepStrictEqual([s.buildTypes, s.platforms], [['Debug', 'Release'], ['Any CPU']]);
c.addSolution(s, 'platforms', 'x64', 'Any CPU');
s.projects[0].cells.get(c.key('Debug', 'x64')).platform = 'x64';
assert.equal(c.write(s), '<Solution>\n  <Configurations>\n    <Platform Name="Any CPU" />\n    <Platform Name="x64" />\n  </Configurations>\n  <Project Path="A/A.csproj">\n    <Platform Solution="Debug|x64" Project="x64" />\n  </Project>\n</Solution>\n');

// An .sln: the whole matrix, VS's "Any CPU" for AnyCPU, Build.0 only for what builds.
const sln = path.join(dir, 'App.sln');
const guid = (i) => `0000000${i + 1}-0000-0000-0000-000000000000`;
const asSln = (model) => [
  'Microsoft Visual Studio Solution File, Format Version 12.00',
  '# Visual Studio Version 17',
  ...model.projects.flatMap((p, i) => [`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${path.basename(p.path, '.csproj')}", "${p.path.replace(/\//g, '\\')}", "{${guid(i)}}"`, 'EndProject']),
  'Global',
  '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
  '\tEndGlobalSection',
  '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
  '\tEndGlobalSection',
  'EndGlobal',
  '',
].join('\r\n');
const toSln = (model) => {
  fs.writeFileSync(sln, asSln(model));
  const target = c.read(sln);
  target.buildTypes = [...model.buildTypes];
  target.platforms = [...model.platforms];
  target.projects.forEach((p, i) => { p.cells = new Map(model.projects[i].cells); });
  fs.writeFileSync(sln, c.write(target));
  return c.read(sln);
};
s = c.read(file);
const back = toSln(s);
assert.ok(back.text.includes(`\t\t{${guid(0)}}.debug web|Any CPU.ActiveCfg = Debug|Any CPU\r\n\t\t{${guid(0)}}.debug web|Any CPU.Build.0 = Debug|Any CPU\r\n`));
assert.ok(back.text.includes(`\t\t{${guid(2)}}.debug web|Any CPU.ActiveCfg = Debug|Any CPU\r\n\t\t{${guid(2)}}.debug web|x64.ActiveCfg`));
assert.ok(back.text.includes('\t\tdebug web|x86 = debug web|x86\r\n'));
back.projects.forEach((p, i) => assert.deepStrictEqual([...p.cells], [...s.projects[i].cells]));
assert.equal(c.write(back), back.text);

// Microsoft's library: the .sln of the same matrix migrated to .slnx gives the same rules, here for the file above and
// for random changes to it.
let dotnet = true;
try {
  execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
} catch {
  dotnet = false;
  console.log('dotnet not found: the comparison with vs-solutionpersistence is skipped');
}
const rulesIn = (t) => [...t.matchAll(/<Project Path="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/Project>)/g)]
  .map(([, p, body = '']) => [p.replace(/\\/g, '/'), body.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^<(BuildType|Platform|Build|Deploy)\b/.test(l))]).sort();
let seed = 7;
const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let round = 0; dotnet && round < 12; round++) {
  s = c.read(file);
  for (let k = 0; k < round; k++) {
    const p = s.projects[random(s.projects.length)];
    const bt = random(3) ? s.buildTypes[random(s.buildTypes.length)] : null;
    const pl = random(3) ? s.platforms[random(s.platforms.length)] : null;
    const change = [{ build: false }, { deploy: true }, { buildType: 'Release' }, { buildType: 'Debug' }, { platform: 'x64' }][random(5)];
    for (const b of bt ? [bt] : s.buildTypes) for (const q of pl ? [pl] : s.platforms) p.cells.set(c.key(b, q), { ...p.cells.get(c.key(b, q)), ...change });
  }
  const mine = c.write(s);
  toSln(s);
  fs.rmSync(path.join(dir, 'App.slnx.migrated'), { force: true });
  const out = path.join(dir, 'migrated');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  fs.copyFileSync(sln, path.join(out, 'App.sln'));
  execFileSync('dotnet', ['sln', path.join(out, 'App.sln'), 'migrate'], { stdio: 'ignore' });
  const theirs = fs.readFileSync(path.join(out, 'App.slnx'), 'utf8');
  assert.deepStrictEqual(rulesIn(mine), rulesIn(theirs), `round ${round}:\n${mine}\n---\n${theirs}`);
}

// Project files: a configuration's PropertyGroups copied for a new one, and renamed.
const csproj = '<Project>\r\n  <PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Debug|AnyCPU\'">\r\n    <Optimize>false</Optimize>\r\n  </PropertyGroup>\r\n</Project>\r\n';
const copied = c.conditionedGroups(csproj, 'buildType', 'Debug', 'Staging', 'copy');
assert.equal(copied, '<Project>\r\n  <PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Debug|AnyCPU\'">\r\n    <Optimize>false</Optimize>\r\n  </PropertyGroup>\r\n  <PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Staging|AnyCPU\'">\r\n    <Optimize>false</Optimize>\r\n  </PropertyGroup>\r\n</Project>\r\n');
assert.equal(c.conditionedGroups(csproj, 'platform', 'Any CPU', 'x64', 'rename'), csproj.replace('Debug|AnyCPU', 'Debug|x64'));

fs.rmSync(dir, { recursive: true, force: true });
console.log('solution-config: ok');
