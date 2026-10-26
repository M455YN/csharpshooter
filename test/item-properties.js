// The Properties window's rules and its edits of a project file, without an editor: node test/item-properties.js
// The edits are also read back by MSBuild (skipped where dotnet is not installed): each file the item type it was given.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ip = require('../item-properties');

const rules = path.join(__dirname, '..', 'rules');
const pl = ip.loadRules(rules, 'pl');
const en = ip.loadRules(rules, 'en');
assert.deepStrictEqual(pl.rules.None.properties.map((p) => p.title),
  ['Akcja kompilacji', 'Kopiuj do katalogu wyjściowego', 'Przestrzeń nazw narzędzia niestandardowego', 'Nazwa pliku', 'Pełna ścieżka', 'Narzędzie niestandardowe']);
assert.deepStrictEqual(pl.rules.None.categories.map((c) => c.title), ['Zaawansowane', 'Różne']);
assert.equal(pl.rules.None.properties.find((p) => p.name === 'FileNameAndExtension').description, 'Nazwa pliku lub folderu.');
assert.deepStrictEqual(pl.rules.None.properties[1].values.map((v) => v.label), ['Nie kopiuj', 'Zawsze kopiuj', 'Kopiuj, jeśli nowszy']);
assert.deepStrictEqual(pl.itemTypes.map((t) => t.label).slice(0, 3), ['Brak', 'Zawartość', 'Zasób osadzony']);
assert.ok(pl.itemTypes.some((t) => t.value === 'Compile' && t.label === 'Kompilator C#'));
assert.deepStrictEqual(pl.rules.Folder.properties.map((p) => p.title), ['Nazwa folderu', 'Pełna ścieżka']);
assert.deepStrictEqual(pl.rules.Project.properties.map((p) => p.title), ['Nazwa pliku', 'Folder projektu', 'Pełna ścieżka']);
assert.equal(en.rules.Compile.properties[0].title, 'Build Action');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shooter-items-'));
const project = path.join(dir, 'App.csproj');
const file = (rel) => path.join(dir, rel);
const original = '<Project Sdk="Microsoft.NET.Sdk">\r\n\r\n\t<PropertyGroup>\r\n\t\t<TargetFramework>net10.0</TargetFramework>\r\n\t</PropertyGroup>\r\n\r\n\t<ItemGroup>\r\n\t  <Content Remove="package.json" />\r\n\t</ItemGroup>\r\n\r\n\t<ItemGroup>\r\n\t  <None Include="package.json" />\r\n\t</ItemGroup>\r\n\r\n</Project>\r\n';
fs.writeFileSync(project, original);
for (const f of ['gulpfile.js', 'package.json', 'Program.cs']) fs.writeFileSync(file(f), '');

// Rows: a file's build action and metadata from MSBuild's items, Nie kopiuj when it sets none.
const items = { None: [{ Identity: 'gulpfile.js', FullPath: file('gulpfile.js') }], Compile: [{ Identity: 'Program.cs', FullPath: file('Program.cs'), Generator: 'X' }] };
let sheet = ip.rowsFor(pl, { kind: 'file', file: file('gulpfile.js') }, items);
const row = (name) => sheet.rows.find((r) => r.name === name);
assert.equal(row('{}{ItemType}').value, 'None');
assert.equal(row('CopyToOutputDirectory').value, 'Never');
assert.equal(row('FileNameAndExtension').value, 'gulpfile.js');
assert.ok(row('FullPath').readOnly && !row('Generator').readOnly);
sheet = ip.rowsFor(pl, { kind: 'file', file: file('Program.cs') }, items);
assert.equal(row('Generator').value, 'X');
sheet = ip.rowsFor(pl, { kind: 'file', file: file('notes.txt') }, items);
assert.deepStrictEqual(sheet.rows.map((r) => r.name), ['FileNameAndExtension', 'FullPath']);
sheet = ip.rowsFor(pl, { kind: 'project', file: project }, items);
assert.deepStrictEqual(sheet.rows.map((r) => r.value), ['App.csproj', dir + path.sep, project]);

// Metadata of a globbed file: an Update, as VS writes it; empty again, the Update goes.
let text = ip.setMetadata(original, project, file('gulpfile.js'), 'None', 'CopyToOutputDirectory', 'PreserveNewest');
assert.ok(text.includes('\t<ItemGroup>\r\n\t  <None Include="package.json" />\r\n\t</ItemGroup>\r\n\r\n\t<ItemGroup>\r\n\t  <None Update="gulpfile.js">\r\n\t    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>\r\n\t  </None>\r\n\t</ItemGroup>\r\n'), text);
text = ip.setMetadata(text, project, file('gulpfile.js'), 'None', 'CopyToOutputDirectory', 'Always');
assert.ok(text.includes('<CopyToOutputDirectory>Always</CopyToOutputDirectory>') && !text.includes('PreserveNewest'));
text = ip.setMetadata(text, project, file('gulpfile.js'), 'None', 'CopyToOutputDirectory', '');
assert.equal(text, original);

// Metadata of a file the project includes itself: in its element.
text = ip.setMetadata(original, project, file('package.json'), 'None', 'Generator', 'Tool');
assert.ok(text.includes('\t  <None Include="package.json">\r\n\t    <Generator>Tool</Generator>\r\n\t  </None>'), text);
assert.equal(ip.setMetadata(text, project, file('package.json'), 'None', 'Generator', ''), original);

// Build action of a globbed file: Remove from its glob, Include as the other; and back.
text = ip.setItemType(original, project, file('gulpfile.js'), 'None', 'Content');
assert.ok(text.includes('\t<ItemGroup>\r\n\t  <None Remove="gulpfile.js" />\r\n\t</ItemGroup>\r\n\r\n\t<ItemGroup>\r\n\t  <Content Include="gulpfile.js" />\r\n\t</ItemGroup>\r\n'), text);
const back = ip.setItemType(text, project, file('gulpfile.js'), 'Content', 'None');
assert.equal(back, original);
// A file taken out of one glob and included as another: back into the glob, both lines gone.
const intoGlob = ip.setItemType(original, project, file('package.json'), 'None', 'Content');
assert.equal(intoGlob.replace(/\s+/g, ' '), '<Project Sdk="Microsoft.NET.Sdk"> <PropertyGroup> <TargetFramework>net10.0</TargetFramework> </PropertyGroup> </Project> ');
// Metadata moves with the file.
text = ip.setMetadata(original, project, file('gulpfile.js'), 'None', 'CopyToOutputDirectory', 'Always');
text = ip.setItemType(text, project, file('gulpfile.js'), 'None', 'Content');
assert.ok(!text.includes('None Update') && text.includes('<Content Include="gulpfile.js">\r\n\t    <CopyToOutputDirectory>Always</CopyToOutputDirectory>\r\n\t  </Content>'), text);

// MSBuild reads them back.
let dotnet = true;
try {
  execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
} catch {
  dotnet = false;
  console.log('dotnet not found: reading the edits back with MSBuild is skipped');
}
if (dotnet) {
  fs.writeFileSync(project, text);
  const out = JSON.parse(execFileSync('dotnet', ['msbuild', project, '-getItem:None', '-getItem:Content'], { encoding: 'utf8' })).Items;
  const of = (type, name) => (out[type] || []).find((i) => i.Identity === name);
  assert.ok(of('Content', 'gulpfile.js')?.CopyToOutputDirectory === 'Always' && !of('None', 'gulpfile.js'), JSON.stringify(out));
  assert.ok(of('None', 'package.json') && !of('Content', 'package.json'));
  fs.writeFileSync(project, intoGlob);
  const glob = JSON.parse(execFileSync('dotnet', ['msbuild', project, '-getItem:None', '-getItem:Content'], { encoding: 'utf8' })).Items;
  // The SDK's Content glob is the Web SDK's; in a plain project the file falls back to None.
  assert.ok((glob.None || []).some((i) => i.Identity === 'package.json'));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('item-properties: ok');
