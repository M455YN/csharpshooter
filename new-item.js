// Solution view → Add → New Item... (Ctrl+Shift+A) and Class... (Shift+Alt+C), as Visual Studio 2026's Add New Item
// lists them for an ASP.NET Core or C# project: its templates' names, descriptions, default names and order (read from
// VS's ItemTemplates/AspNetCore .vstemplate files and the packages that name them; VS's Polish in l10n/pl.json). VS's
// template files are VS's own, so the files are made here or by the .NET SDK's item templates (dotnet new, MIT), which
// VS's TemplateEngine wizard runs for the Razor ones too. Web-only items show for a web project (Sdk.Web/Razor).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { t, n_ } = require('./l10n');
const { readProject } = require('./solution');
const { targetOf, namespaceFor, projectStyle } = require('./add-items');

/** A C# file in the project's style: its usings, then the namespace (file-scoped or a block) around the body. */
function csharp(style, ns, body, usings = []) {
  const lines = usings.length ? [...usings.map((u) => `using ${u};`), ''] : [];
  if (style.fileScoped) lines.push(`namespace ${ns};`, '', ...body);
  else lines.push(`namespace ${ns}`, '{', ...body.map((l) => (l ? `    ${l}` : l)), '}');
  return lines.join(style.eol) + style.eol;
}

// [VS's English name, description, default file name, web only, how it is made]. In VS's order (SortOrder).
// make: { sdk: short name, args } runs dotnet new; { text(ctx) } writes the file.
const ITEMS = [
  [n_('Class'), n_('An empty class declaration'), 'Class.cs', false, { text: (c) => csharp(c.style, c.ns, [`public class ${c.base}`, '{', '}']) }],
  [n_('Interface'), n_('An empty interface definition'), 'Interface.cs', false, { text: (c) => csharp(c.style, c.ns, [`public interface ${c.base}`, '{', '}']) }],
  [n_('Razor Component'), n_('A reusable UI component implemented with Razor'), 'Component.razor', true, { sdk: 'razorcomponent' }],
  [n_('MVC Controller - Empty'), n_('An MVC controller class (ASP.NET MVC requires controller names to end in "Controller")'), 'HomeController.cs', true, { sdk: 'mvccontroller', ns: true }],
  [n_('MVC Controller with read/write actions'), n_('An MVC controller with actions to create, update, delete and list entities'), 'HomeController.cs', true, { sdk: 'mvccontroller', ns: true, args: ['--actions', 'true'] }],
  [n_('API Controller - Empty'), n_('An empty API controller class'), 'ValuesController.cs', true, { sdk: 'apicontroller', ns: true }],
  [n_('API Controller with read/write actions'), n_('An API controller with actions to create, update, delete and list entities'), 'ValuesController.cs', true, { sdk: 'apicontroller', ns: true, args: ['--actions', 'true'] }],
  [n_('Razor Page - Empty'), n_('A Razor page with a page model'), 'Index.cshtml', true, { sdk: 'page', ns: true }],
  [n_('Razor View - Empty'), n_('A Razor view page'), 'Index.cshtml', true, { sdk: 'view' }],
  [n_('Razor Layout'), n_('A Razor view layout page'), '_Layout.cshtml', true, {
    text: (c) => ['<!DOCTYPE html>', '<html>', '<head>', '    <meta charset="utf-8" />', '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <title>@ViewBag.Title</title>', '</head>', '<body>', '    <div>', '        @RenderBody()', '    </div>', '</body>', '</html>', ''].join(c.style.eol),
  }],
  [n_('Razor View Start'), n_('A Razor view start page'), '_ViewStart.cshtml', true, { sdk: 'viewstart', fixedName: true }],
  [n_('Razor View Imports'), n_('A Razor view imports page'), '_ViewImports.cshtml', true, { sdk: 'viewimports', ns: true, fixedName: true }],
  [n_('Tag Helper Class'), n_('A class for writing a tag helper'), 'RazorTagHelper.cs', true, {
    text: (c) => csharp(c.style, c.ns, [
      `// You may need to install the Microsoft.AspNetCore.Razor.Runtime package into your project`,
      `[HtmlTargetElement("tag-name")]`, `public class ${c.base} : TagHelper`, '{',
      '    public override void Process(TagHelperContext context, TagHelperOutput output)', '    {', '    }', '}'], ['Microsoft.AspNetCore.Razor.TagHelpers']),
  }],
  [n_('Middleware Class'), n_('A class for writing middleware'), 'Middleware.cs', true, {
    text: (c) => csharp(c.style, c.ns, [
      `public class ${c.base}`, '{', '    private readonly RequestDelegate _next;', '',
      `    public ${c.base}(RequestDelegate next)`, '    {', '        _next = next;', '    }', '',
      '    public Task Invoke(HttpContext httpContext)', '    {', '        return _next(httpContext);', '    }', '}', '',
      `public static class ${c.base}Extensions`, '{',
      `    public static IApplicationBuilder Use${c.base}(this IApplicationBuilder builder)`, '    {',
      `        return builder.UseMiddleware<${c.base}>();`, '    }', '}'], ['Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Http']),
  }],
  [n_('Startup Class'), n_('A class to configure the application'), 'Startup.cs', true, {
    text: (c) => csharp(c.style, c.ns, [
      `public class ${c.base}`, '{', '    public void ConfigureServices(IServiceCollection services)', '    {', '    }', '',
      '    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)', '    {', '    }', '}'],
    ['Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Hosting', 'Microsoft.Extensions.DependencyInjection']),
  }],
  [n_('App Settings File'), n_('An appsettings.json file for configuring web applications'), 'appsettings.json', true, {
    text: (c) => JSON.stringify({ Logging: { LogLevel: { Default: 'Information', 'Microsoft.AspNetCore': 'Warning' } } }, null, 2).replace(/\n/g, c.style.eol) + c.style.eol,
  }],
  [n_('Resources File'), n_('A file for storing resources'), 'Resource.resx', false, {
    text: (c) => ['<?xml version="1.0" encoding="utf-8"?>', '<root>',
      '  <resheader name="resmimetype">', '    <value>text/microsoft-resx</value>', '  </resheader>',
      '  <resheader name="version">', '    <value>2.0</value>', '  </resheader>',
      '  <resheader name="reader">', '    <value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>', '  </resheader>',
      '  <resheader name="writer">', '    <value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>', '  </resheader>',
      '</root>', ''].join(c.style.eol),
  }],
  [n_('Text File'), n_('An empty text file'), 'TextFile.txt', false, { text: () => '' }],
  [n_('HTML Page'), n_('An HTML page that can include client-side code'), 'HTMLPage.html', true, {
    text: (c) => ['<!DOCTYPE html>', '<html lang="en">', '<head>', '    <meta charset="utf-8" />', '    <title></title>', '</head>', '<body>', '', '</body>', '</html>', ''].join(c.style.eol),
  }],
  [n_('JavaScript File'), n_('A script file containing JavaScript code'), 'JavaScript.js', true, { text: () => '' }],
  [n_('Style Sheet'), n_('A cascading style sheet (CSS) used for rich HTML style definitions'), 'StyleSheet.css', true, { text: (c) => `body {${c.style.eol}}${c.style.eol}` }],
  [n_('TypeScript File'), n_('An empty TypeScript source file'), 'file.ts', true, { text: () => '' }],
  [n_('TypeScript JSX File'), n_('An empty TypeScript JSX source file'), 'file.tsx', true, { text: () => '' }],
  [n_('JavaScript JSON Configuration File'), n_('A JSON configuration file for the JavaScript language service'), 'jsconfig.json', true, {
    text: (c) => JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' }, exclude: ['node_modules', 'wwwroot/lib'] }, null, 2).replace(/\n/g, c.style.eol) + c.style.eol,
  }],
  [n_('TypeScript JSON Configuration File'), n_('A JSON configuration file for the TypeScript compiler'), 'tsconfig.json', true, {
    text: (c) => JSON.stringify({ compilerOptions: { noImplicitAny: false, noEmitOnError: true, removeComments: false, sourceMap: true, target: 'ES2022' }, exclude: ['node_modules', 'wwwroot'] }, null, 2).replace(/\n/g, c.style.eol) + c.style.eol,
  }],
  [n_('JSON File'), n_('JSON is a lightweight data-interchange format.'), 'json.json', false, { text: (c) => `{${c.style.eol}}${c.style.eol}` }],
  [n_('JSON Schema File'), n_('JSON schema files describe the format of JSON files\' data.'), 'json-schema.json', false, {
    text: (c) => JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', title: 'JSON Schema', type: 'object', properties: {} }, null, 2).replace(/\n/g, c.style.eol) + c.style.eol,
  }],
  [n_('HTTP File'), n_('A file containing HTTP/REST requests'), 'app.http', true, {
    text: (c) => [`@${c.project.replace(/\W/g, '_')}_HostAddress = ${c.url}`, '', `GET {{${c.project.replace(/\W/g, '_')}_HostAddress}}/`, 'Accept: application/json', '', '###', ''].join(c.style.eol),
  }],
  [n_('Web Configuration File'), n_('A file for configuring web application settings'), 'web.config', true, { sdk: 'webconfig', fixedName: true }],
  [n_('Assembly Information File'), n_('A file containing basic assembly information'), 'AssemblyInfo.cs', false, {
    text: (c) => ['using System.Runtime.InteropServices;', '', '[assembly: ComVisible(false)]', ''].join(c.style.eol),
  }],
  [n_('Protocol Buffer File'), n_('A protocol buffer file for describing messages and services for gRPC.'), 'protobuf.proto', false, {
    text: (c) => ['syntax = "proto3";', '', `option csharp_namespace = "${c.ns}";`, '', `package ${c.base.toLowerCase()};`, ''].join(c.style.eol),
  }],
  [n_('JSX File'), n_('JSX is a file type used by the React JavaScript library.'), 'jsx.jsx', true, { text: () => '' }],
  [n_('XML File'), n_('A blank XML file'), 'XMLFile.xml', false, { text: (c) => `<?xml version="1.0" encoding="utf-8" ?>${c.style.eol}` }],
  [n_('LESS Style Sheet'), n_('LESS is a language that compiles into CSS.'), 'StyleSheet.less', true, { text: (c) => `body {${c.style.eol}}${c.style.eol}` }],
  [n_('SCSS Style Sheet (SASS)'), n_('SCSS is a language that compiles into CSS.'), 'StyleSheet.scss', true, { text: (c) => `body {${c.style.eol}}${c.style.eol}` }],
  [n_('npm Configuration File'), n_('An npm configuration file for package.json'), 'package.json', true, {
    text: (c) => JSON.stringify({ version: '1.0.0', name: 'asp.net', private: true, devDependencies: {} }, null, 2).replace(/\n/g, c.style.eol) + c.style.eol,
  }],
  [n_('YAML File'), n_('YAML is a human-friendly data serialization standard for all programming languages.'), 'YAMLFile.yml', false, { text: () => '' }],
  [n_('Code File'), n_('An empty C# code file'), 'CodeFile.cs', false, { text: () => '' }],
];

/** The default file name, made unique in the folder as VS makes it: Class.cs, else Class1.cs, Class2.cs... */
function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) if (!fs.existsSync(path.join(dir, `${base}${n}${ext}`))) return `${base}${n}${ext}`;
}

const dotnetNew = (args, cwd) => new Promise((resolve) => {
  execFile('dotnet', ['new', ...args], { cwd, windowsHide: true, timeout: 120000 }, (e, out, err) => resolve({ ok: !e, said: `${out}${err}`.trim() }));
});

/** The project's first http URL from its launch profiles, for an .http file's host. */
function firstUrl(project) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(path.dirname(project), 'Properties', 'launchSettings.json'), 'utf8').replace(/^﻿/, ''));
    for (const p of Object.values(settings.profiles || {})) {
      const url = (p.applicationUrl || '').split(';').find((u) => /^https?:/.test(u));
      if (url) return url;
    }
  } catch {
    // no profiles
  }
  return 'http://localhost:5000';
}

/** Makes one item in a folder of a project: the file written or dotnet new run, then opened and shown in the tree. */
async function make(entry, dir, project, fileName, reveal) {
  const [, , defaultName, , how] = entry;
  const ext = path.extname(defaultName);
  if (!how.fixedName && ext && !fileName.toLowerCase().endsWith(ext.toLowerCase())) fileName += ext;
  if (how.fixedName) fileName = defaultName;
  const file = path.join(dir, fileName);
  if (fs.existsSync(file)) {
    vscode.window.showErrorMessage(t('A file or folder with the name "{0}" already exists at this location on disk. Choose a different name.', fileName));
    return undefined;
  }
  const base = fileName.slice(0, fileName.length - ext.length);
  const ns = namespaceFor(project, dir);
  if (how.sdk) {
    fs.mkdirSync(dir, { recursive: true });
    const args = [how.sdk, ...(how.fixedName ? [] : ['-n', base]), '-o', dir, ...(how.ns ? ['--namespace', ns] : []), ...(how.args || [])];
    const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `dotnet new ${how.sdk}` }, () => dotnetNew(args, dir));
    if (!done.ok || !fs.existsSync(file)) {
      vscode.window.showErrorMessage(t('dotnet new {0} failed: {1}', how.sdk, done.said.split(/\r?\n/).slice(-3).join(' ')));
      return undefined;
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, how.text({ style: projectStyle(project), ns, base, project: readProject(project).name || path.basename(project, '.csproj'), url: firstUrl(project) }));
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  await reveal(file);
  return file;
}

const isWeb = (project) => /\.(Web|Razor|BlazorWebAssembly)$/.test(readProject(project).sdk || '');

/** Add → New Item...: VS's list for the project, then the name. `choice` (the tests'): { item: English name, name }. */
async function addNewItem(item, reveal, choice) {
  const { dir, project } = targetOf(item);
  if (!project) return undefined;
  const web = isWeb(project);
  const entries = ITEMS.filter((e) => web || !e[3]);
  let entry = choice && entries.find((e) => e[0] === choice.item);
  if (!entry) {
    const picked = await vscode.window.showQuickPick(entries.map((e) => ({ label: t(e[0]), description: /\.(cs|razor|cshtml)$/.test(e[2]) ? 'C#' : '', detail: t(e[1]), entry: e })),
      { title: t('Add New Item - {0}', path.basename(project, '.csproj')), placeHolder: t('Search (Ctrl+E)'), matchOnDetail: true });
    if (!picked) return undefined;
    entry = picked.entry;
  }
  return addItem(entry, dir, project, reveal, choice?.name);
}

async function addItem(entry, dir, project, reveal, name) {
  if (entry[4].fixedName) return make(entry, dir, project, entry[2], reveal);
  name ??= await vscode.window.showInputBox({
    title: t(entry[0]), prompt: t('Name:'), value: freeName(dir, entry[2]), valueSelection: [0, freeName(dir, entry[2]).length - path.extname(entry[2]).length],
    validateInput: (v) => (!v.trim() || /[\\/:*?"<>|]/.test(v) ? t('Not a valid file name.') : undefined),
  });
  return name ? make(entry, dir, project, name.trim(), reveal) : undefined;
}

/** Add → Class... (Shift+Alt+C): VS's Add New Item with Class chosen. */
function addClass(item, reveal, name) {
  const { dir, project } = targetOf(item);
  return project ? addItem(ITEMS[0], dir, project, reveal, name) : undefined;
}

module.exports = { addNewItem, addClass, ITEMS, freeName };
