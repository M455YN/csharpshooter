// Downloads roslyn-language-server.<rid> from nuget.org into server/: node scripts/fetch-server.js [version] [rid]
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const version = process.argv[2] || '5.11.0';
const rid = process.argv[3] || `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const id = `roslyn-language-server.${rid}`;
const url = `https://api.nuget.org/v3-flatcontainer/${id}/${version}/${id}.${version}.nupkg`;

function download(from, to) {
  return new Promise((resolve, reject) => {
    https.get(from, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return download(res.headers.location, to).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`${from}: HTTP ${res.statusCode}`));
      res.pipe(fs.createWriteStream(to)).on('finish', resolve).on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'roslyn-'));
  const nupkg = path.join(work, 'server.zip');
  console.log(`Downloading ${url}`);
  await download(url, nupkg);
  // Windows' own tar is bsdtar, which reads zips (Git's GNU tar on PATH does not); on Linux install bsdtar or use unzip.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', nupkg, '-C', work]);
  const tools = path.join(work, 'tools');
  const tfm = fs.readdirSync(tools)[0];
  const from = path.join(tools, tfm, rid);
  const to = path.join(__dirname, '..', 'server');
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Server ${version} (${rid}, ${tfm}) in ${to}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
