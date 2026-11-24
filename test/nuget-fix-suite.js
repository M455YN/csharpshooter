// NuGet — rozwiązanie's fix of a vulnerable package a project gets through others, in a real editor on a solution of the
// test's own: a netstandard2.0 library whose Microsoft.Extensions.Configuration.Json 8.0.0 brings System.Text.Json 8.0.0
// (GHSA-hh2w-p6rv-4g7w, GHSA-8g4q-xg66-9fp4), as Passenger 0.4.1 offers it (#1793).
//   node test/nuget-fix-suite.js <empty folder>          (makes the solution: Contoso.Fix)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/nuget-fix-suite.js node test/runTest.js
const fs = require('fs');
const path = require('path');

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  const run = (...args) => execFileSync('dotnet', args, { cwd: folder, stdio: 'inherit' });
  fs.mkdirSync(folder, { recursive: true });
  run('new', 'sln', '-n', 'Contoso.Fix', '--format', 'sln');
  run('new', 'classlib', '-n', 'Contoso.Fix.Lib', '-o', 'Lib', '-f', 'netstandard2.0');
  run('add', 'Lib', 'package', 'Microsoft.Extensions.Configuration.Json', '--version', '8.0.0');
  run('sln', 'add', 'Lib');
  process.exit(0);
}

const vscode = require('vscode');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const lines = [];
  let failed = 0;
  const expect = (name, ok, got) => {
    failed += ok ? 0 : 1;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}`);
  };
  const api = await vscode.extensions.getExtension('M455YN.csharpshooter').activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const csproj = path.join(root, 'Lib', 'Contoso.Fix.Lib.csproj');
  const before = fs.readFileSync(csproj);
  const page = await api.nugetPage.open();
  try {
    const data = await Promise.race([page.loaded(), sleep(180000)]);
    const stj = data && [...data.packages.values()].find((p) => p.id.toLowerCase() === 'system.text.json');
    expect('System.Text.Json 8.0.0, through another package, vulnerable', stj && !stj.projects.size && [...stj.advisories.values()].some((a) => a.length),
      stj ? `${[...stj.transitive.values()].map((v) => v.resolved).join()}; ${page.shown?.banner}` : 'not listed');
    await page.request({ type: 'select', id: 'System.Text.Json' });
    for (const end = Date.now() + 60000; !page.shown.details?.fix && Date.now() < end;) await sleep(300);
    const d = page.shown.details;
    const newer = (a, b) => api.nugetPage.compareVersions(a, b) > 0;
    expect('the pane offers the lowest version with no known vulnerability, and picks it', d?.fix && newer(d.fix.version, '8.0.4') && d.chosen === d.fix.version,
      `${d?.fix?.text} ${d?.fix?.more} (chosen ${d?.chosen})`);
    const ticked = (d?.projects || []).filter((p) => p.checked).map((p) => p.name);
    expect('the projects that get it through others are ticked', ticked.length === 1 && ticked[0] === 'Contoso.Fix.Lib', ticked.join(', ') || 'none');
    if (!d?.fix) throw new Error('no fix offered');
    page.dialog = undefined;
    await page.request({ type: 'install', version: d.fix.version });
    const preview = page.dialog;
    expect('Install shows Preview Changes', preview?.preview?.length === 1, JSON.stringify(preview?.preview?.map((p) => p.sections.map((s) => s.items))) || page.shown.status?.text);
    if (!preview) throw new Error('no Preview Changes');
    await page.request(preview.buttons[0].answer);
    const text = fs.readFileSync(csproj, 'utf8');
    expect('the project references the fixed version', new RegExp(`Include="System\\.Text\\.Json" Version="${d.fix.version.replace(/\./g, '\\.')}"`).test(text), text.match(/<PackageReference[^>]*>/g)?.join(' '));
    const after = (await page.loaded())?.packages.get('system.text.json');
    expect('no longer vulnerable', after && ![...after.advisories.values()].some((a) => a.length), page.shown.banner || 'no banner');
  } finally {
    page.dispose();
    fs.writeFileSync(csproj, before);
    await new Promise((resolve) => require('child_process').execFile('dotnet', ['restore', '--force', csproj], { windowsHide: true }, resolve));
    console.log(lines.join('\n'));
  }
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
