// Call Hierarchy in a real editor on a small project of the test's own: at a use of a method declared in another file, and
// at a record's positional property from a use and at its declaration (Passenger 0.4.1's #1916, through CSharpShooter's
// extension to the C# server).
//   node test/call-hierarchy-suite.js <empty folder>          (makes the project: Contoso.Calls, a console app)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/call-hierarchy-suite.js node test/runTest.js
const fs = require('fs');
const path = require('path');

const HELPER = `namespace Contoso.Calls;

public static class Helper
{
    public static int Twice(int x) => x * 2;
}

public record Release(string Version);
`;
const PROGRAM = `using Contoso.Calls;

System.Console.WriteLine(Twice4());
System.Console.WriteLine(Describe(new Release("1.0")));

static int Twice4() => Helper.Twice(4);

static string Describe(Release release) => release.Version;
`;

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  execFileSync('dotnet', ['new', 'console', '-n', 'Contoso.Calls', '-o', folder], { stdio: 'inherit' });
  fs.writeFileSync(path.join(folder, 'Helper.cs'), HELPER);
  fs.writeFileSync(path.join(folder, 'Program.cs'), PROGRAM);
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
  const ext = vscode.extensions.getExtension('M455YN.csharpshooter');
  const api = await ext.activate();
  await api.whenReady();
  for (let i = 0; i < 600 && api.loading() && !api.loading().done; i++) await sleep(500);
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const at = async (name, text, offset = 0) => {
    const doc = await vscode.workspace.openTextDocument(path.join(root, name));
    await vscode.window.showTextDocument(doc);
    return { uri: doc.uri, position: doc.positionAt(doc.getText().indexOf(text) + offset) };
  };
  // The server can answer before it has read a file just opened: asked again for a while.
  const prepare = async ({ uri, position }) => {
    for (let i = 0; i < 40; i++) {
      const items = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, position);
      if (items?.length) return items;
      await sleep(500);
    }
    return [];
  };
  const callers = async (item) => (await vscode.commands.executeCommand('vscode.provideIncomingCalls', item) || []).map((c) => c.from.name);

  const twice = await prepare(await at('Program.cs', 'Helper.Twice', 'Helper.'.length + 1));
  expect('at a use in another file: the method', twice[0]?.name.includes('Twice') && twice[0]?.uri.fsPath.endsWith('Helper.cs'), twice.map((i) => `${i.name} ${path.basename(i.uri.fsPath)}`).join(', ') || 'none');
  const twiceCallers = twice[0] ? await callers(twice[0]) : [];
  expect('its callers', twiceCallers.some((n) => n.includes('Twice4')), twiceCallers.join(', ') || 'none');

  const fromUse = await prepare(await at('Program.cs', 'release.Version', 'release.'.length + 1));
  expect("a record's positional property from a use", fromUse[0]?.name.includes('Version'), fromUse.map((i) => i.name).join(', ') || 'none');
  const declared = await prepare(await at('Helper.cs', 'string Version', 'string '.length + 1));
  expect("a record's positional property at its declaration", declared[0]?.name.includes('Version'), declared.map((i) => i.name).join(', ') || 'none');
  const readers = declared[0] ? await callers(declared[0]) : [];
  expect('its readers', readers.some((n) => n.includes('Describe')), readers.join(', ') || 'none');

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
