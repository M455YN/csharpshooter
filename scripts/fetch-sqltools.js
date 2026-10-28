// Downloads Microsoft's SQL Tools Service (github.com/microsoft/sqltoolsservice, MIT) into sqltools/: the server behind
// .sql files' IntelliSense and connections, as vscode-mssql runs it. node scripts/fetch-sqltools.js [version] [rid]
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const version = process.argv[2] || '6.0.20261023.1';
const rid = process.argv[3] || `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const asset = `Microsoft.SqlTools.ServiceLayer-${rid}-net10.0.zip`;
const url = `https://github.com/microsoft/sqltoolsservice/releases/download/${version}/${asset}`;

function download(from, to) {
  return new Promise((resolve, reject) => {
    https.get(from, { headers: { 'User-Agent': 'csharpshooter' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return download(res.headers.location, to).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`${from}: HTTP ${res.statusCode}`));
      res.pipe(fs.createWriteStream(to)).on('finish', resolve).on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqltools-'));
  const zip = path.join(work, asset);
  console.log(`Downloading ${url}`);
  await download(url, zip);
  const to = path.join(__dirname, '..', 'sqltools');
  // Emptied rather than removed: Windows refuses to remove a folder a shell or Explorer has open.
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(to)) fs.rmSync(path.join(to, entry), { recursive: true, force: true });
  // Windows' own tar is bsdtar, which reads zips (Git's GNU tar on PATH does not); on Linux install bsdtar or use unzip.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', zip, '-C', to]);
  fs.rmSync(work, { recursive: true, force: true });
  // The package is the whole of Azure Data Studio's back end, with its own .NET: left out are what IntelliSense and
  // connections do not use (the migration tool and its Azure price lists), symbols and docs, and the texts of languages
  // other than English and Polish.
  const keep = new Set(['pl', 'pl-PL', 'refs']);
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    const drop = entry.isDirectory()
      ? /^[a-z]{2}(-[A-Za-z]+)?$/.test(entry.name) && !keep.has(entry.name) || ['Data', 'TargetAssessment'].includes(entry.name)
      : /\.(pdb|xml)$/i.test(entry.name) || entry.name.startsWith('MicrosoftSqlToolsMigration');
    if (drop) fs.rmSync(path.join(to, entry.name), { recursive: true, force: true });
  }
  // It is self-contained; without its copy of .NET (80 MB) it runs on the installed .NET 10 runtime, as the C# server and
  // the debugger do: `dotnet MicrosoftSqlToolsServiceLayer.dll`. The apphosts only start the copy, so they go too.
  const deps = path.join(to, 'MicrosoftSqlToolsServiceLayer.deps.json');
  const manifest = JSON.parse(fs.readFileSync(deps, 'utf8'));
  const target = manifest.targets[manifest.runtimeTarget.name];
  for (const name of Object.keys(target).filter((n) => n.startsWith('runtimepack.'))) {
    for (const file of [...Object.keys(target[name].runtime || {}), ...Object.keys(target[name].native || {})]) fs.rmSync(path.join(to, file), { force: true });
    delete target[name];
    delete manifest.libraries[name];
  }
  fs.writeFileSync(deps, JSON.stringify(manifest, null, 2));
  for (const config of fs.readdirSync(to).filter((f) => f.endsWith('.runtimeconfig.json'))) {
    const file = path.join(to, config);
    const { runtimeOptions } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { includedFrameworks, ...rest } = runtimeOptions;
    const framework = { name: 'Microsoft.NETCore.App', version: `${includedFrameworks[0].version.split('.').slice(0, 2).join('.')}.0` };
    fs.writeFileSync(file, JSON.stringify({ runtimeOptions: { ...rest, framework } }, null, 2));
    fs.rmSync(path.join(to, config.replace('.runtimeconfig.json', '.exe')), { force: true });
  }
  console.log(`SQL Tools Service ${version} (${rid}) in ${to}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
