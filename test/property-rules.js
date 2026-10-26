// The project Properties page's rules and project-file edits, without an editor: node test/property-rules.js
const assert = require('assert');
const path = require('path');
const r = require('../property-rules');

const rules = path.join(__dirname, '..', 'rules');
const en = r.loadPages(rules, 'en');
const pl = r.loadPages(rules, 'pl');
assert.deepStrictEqual(en.map((p) => p.name), ['Application', 'References', 'Build', 'Package', 'CodeAnalysisPropertyPage', 'DebugPropertyPage', 'ResourcesPropertyPage', 'SettingsPropertyPage']);
assert.deepStrictEqual(pl.map((p) => p.title), ['Aplikacja', 'Użycie globalne', 'Kompilacja', 'Pakiet', 'Analiza kodu', 'Debuguj', 'Zasoby', 'Ustawienia']);
const app = pl.find((p) => p.name === 'Application');
assert.deepStrictEqual(app.categories.map((c) => c.title), ['Ogólne', 'Zasoby Win32', 'Zależności', 'Pakowanie']); // .CSharp extends Resources and adds Packaging
const outputType = app.properties.find((p) => p.name === 'OutputType');
assert.equal(outputType.title, 'Typ danych wyjściowych');
assert.equal(outputType.values.find((v) => v.value === 'Library').label, 'Biblioteka klas');
const tfm = app.properties.find((p) => p.name === 'InterceptedTargetFramework');
assert.equal(tfm.metadata.SearchTerms, 'TFM');
assert.ok(tfm.metadata.VisibilityCondition.includes('TargetMultipleFrameworks'));
const define = pl.find((p) => p.name === 'Build').properties.find((p) => p.name === 'DefineConstants');
assert.ok(define.perConfiguration && define.persistence === 'ProjectFileWithInterception');

// Conditions.
const ctx = (values, msbuild = {}, caps = []) => ({ value: (rule, name) => values[`${rule}::${name}`], msbuild: (n) => msbuild[n] || '', capabilities: new Set(caps.map((c) => c.toLowerCase())) });
assert.equal(r.evaluateCondition('(not (has-evaluated-value "Application" "TargetMultipleFrameworks" true))', ctx({ 'Application::TargetMultipleFrameworks': 'false' })), true);
assert.equal(r.evaluateCondition('(has-evaluated-value "Application" "TargetMultipleFrameworks" true)', ctx({ 'Application::TargetMultipleFrameworks': 'false' })), false);
const net = { TargetFrameworkIdentifier: '.NETCoreApp', TargetFrameworkVersion: 'v10.0', LangVersion: '14.0' };
assert.equal(r.evaluateCondition('(and (has-net-core-app-version-or-greater "5.0") (not (has-evaluated-value "Application" "TargetMultipleFrameworks" true)))', ctx({}, net)), true);
assert.equal(r.evaluateCondition('(has-net-core-app-version-or-greater "11.0")', ctx({}, net)), false);
assert.equal(r.evaluateCondition('(has-csharp-lang-version-or-greater "10")', ctx({}, net)), true);
const withPlatform = (u) => ({ ...ctx({}, net), unevaluated: (rule, name) => (rule === 'Application' && name === 'TargetPlatformIdentifier' ? u : undefined) });
const platformVersion = '(and (has-net-core-app-version-or-greater "5.0") (and (ne (unevaluated "Application" "TargetPlatformIdentifier") "") (not (has-evaluated-value "Application" "TargetMultipleFrameworks" true))))';
assert.equal(r.evaluateCondition(platformVersion, withPlatform('')), false);
assert.equal(r.evaluateCondition(platformVersion, withPlatform(undefined)), false);
assert.equal(r.evaluateCondition(platformVersion, withPlatform('windows')), true);
assert.equal(r.evaluateCondition('(has-project-capability "WindowsForms")', ctx({}, net, ['CSharp'])), false);
assert.equal(r.evaluateCondition('(or (has-project-capability "WindowsForms") (has-net-framework))', ctx({}, { TargetFrameworkIdentifier: '.NETFramework' })), true);

// The project file: a property set where it is, a new one in the first unconditional group, one per configuration in
// its group (made VS's way when there is none), and every removal giving the file back byte for byte.
const project = '<Project Sdk="Microsoft.NET.Sdk">\r\n\r\n  <PropertyGroup>\r\n    <TargetFramework>net10.0</TargetFramework>\r\n    <AssemblyName>App</AssemblyName>\r\n  </PropertyGroup>\r\n\r\n  <PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Debug|AnyCPU\'">\r\n    <NoWarn>CS0618</NoWarn>\r\n  </PropertyGroup>\r\n\r\n</Project>\r\n';
assert.equal(r.readProperty(project, 'AssemblyName', ''), 'App');
assert.equal(r.readProperty(project, 'NoWarn', ''), undefined);
assert.equal(r.readProperty(project, 'NoWarn', 'debug|anycpu'), 'CS0618');
let t = r.writeProperty(project, 'AssemblyName', 'Other & <Co>', '');
assert.ok(t.includes('<AssemblyName>Other &amp; &lt;Co&gt;</AssemblyName>'));
assert.equal(r.readProperty(t, 'AssemblyName', ''), 'Other & <Co>');
t = r.writeProperty(project, 'AssemblyTitle', 'Title', '');
assert.ok(t.includes('    <AssemblyName>App</AssemblyName>\r\n    <AssemblyTitle>Title</AssemblyTitle>\r\n  </PropertyGroup>'));
assert.equal(r.writeProperty(t, 'AssemblyTitle', null, ''), project);
t = r.writeProperty(project, 'Optimize', 'true', 'debug|anycpu', r.configCondition('Debug', 'Any CPU'));
assert.ok(t.includes('    <NoWarn>CS0618</NoWarn>\r\n    <Optimize>true</Optimize>'));
assert.equal(r.writeProperty(t, 'Optimize', null, 'debug|anycpu'), project);
t = r.writeProperty(project, 'Optimize', 'true', 'release|anycpu', r.configCondition('Release', 'Any CPU'));
assert.ok(t.includes('<PropertyGroup Condition="\'$(Configuration)|$(Platform)\'==\'Release|AnyCPU\'">\r\n    <Optimize>true</Optimize>\r\n  </PropertyGroup>'));
assert.equal(r.readProperty(t, 'Optimize', 'release|anycpu'), 'true');
assert.equal(r.writeProperty(t, 'Optimize', null, 'release|anycpu'), project);

// Build events, as targets; Using items.
t = r.writeBuildEvent(project, 'PostBuild', 'echo "done" > x.txt');
assert.ok(t.includes('<Target Name="PostBuild" AfterTargets="PostBuildEvent">\r\n    <Exec Command="echo &quot;done&quot; &gt; x.txt" />\r\n  </Target>'));
assert.equal(r.readBuildEvent(t, 'PostBuild'), 'echo "done" > x.txt');
assert.equal(r.writeBuildEvent(t, 'PostBuild', ''), project.replace(/\r\n\r\n<\/Project>/, '\r\n\r\n</Project>'));
t = r.writeUsing(project, 'Include', 'System.Text.Json', true);
assert.deepStrictEqual(r.readUsings(t), [{ kind: 'Include', name: 'System.Text.Json', alias: '', isStatic: false }]);
assert.equal(r.readUsings(r.writeUsing(t, 'Include', 'System.Text.Json', false)).length, 0);

// The interceptors.
const io = (u, e, items = {}) => ({ u: (n) => u[n], e: (n) => e[n] || '', items: (n) => items[n] || [], text: '', project: 'C:\\p\\App.csproj' });
const prop = (name, persistedName = name) => ({ name, persistedName });
const items = { SupportedTargetFramework: [{ Identity: '.NETCoreApp,Version=v8.0', Alias: 'net8.0' }, { Identity: '.NETFramework,Version=v4.8', Alias: 'net48' }] };
assert.deepStrictEqual(r.writesFor(prop('InterceptedTargetFramework'), io({}, {}, items), '.NETCoreApp,Version=v8.0'), [{ name: 'TargetFramework', value: 'net8.0' }]);
assert.deepStrictEqual(r.writesFor(prop('InterceptedTargetFramework'), io({}, {}, items), '.NETFramework,Version=v4.8')[0], { name: 'TargetFramework', value: 'net48' });
assert.deepStrictEqual(r.writesFor(prop('TargetMultipleFrameworks'), io({ TargetFramework: 'net10.0' }, {}), 'true'), [{ name: 'TargetFrameworks', value: 'net10.0' }, { name: 'TargetFramework', value: null }]);
assert.deepStrictEqual(r.valueOf(prop('ResourceSpecificationKind'), io({ Win32Resource: 'a.res' }, { Win32Resource: 'a.res' })), { u: 'ResourceFile', e: 'ResourceFile' });
assert.deepStrictEqual(r.valueOf(prop('DefineConstants'), io({ DefineConstants: '$(DefineConstants);A;B' }, { DefineConstants: 'TRACE;DEBUG;A;B' })), { u: 'A;B', e: 'TRACE;DEBUG;A;B' });
assert.deepStrictEqual(r.writesFor(prop('DefineConstants'), io({}, {}), 'A; B'), [{ name: 'DefineConstants', value: '$(DefineConstants);A;B' }]);
assert.deepStrictEqual(r.writesFor(prop('ImplicitUsings'), io({}, {}), 'true'), [{ name: 'ImplicitUsings', value: 'enable' }]);
assert.equal(r.valueOf(prop('AssemblyVersion'), io({}, { Version: '2.1.3-beta' })).e, '2.1.3.0');
assert.deepStrictEqual(r.writesFor(prop('AssemblyTitle'), io({}, {}), ''), [{ name: 'AssemblyTitle', value: null }]);
console.log(`property rules: ${pl.length} pages, ${pl.reduce((n, p) => n + p.properties.length, 0)} properties, edits and interceptors as VS's`);
