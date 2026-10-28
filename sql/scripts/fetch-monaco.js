// Downloads Microsoft's Monaco editor (monaco-editor on npm, MIT) into media/monaco/vs: the editor of .sql files' SQL
// editor page (sql-editor.js), as vsc-ms-sql-manager's SQL editor has it, but shipped with the extension instead of
// loaded from a CDN. node scripts/fetch-monaco.js [version]
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const version = process.argv[2] || '0.55.1';
const url = `https://registry.npmjs.org/monaco-editor/-/monaco-editor-${version}.tgz`;

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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'monaco-'));
  const tgz = path.join(work, 'monaco.tgz');
  console.log(`Downloading ${url}`);
  await download(url, tgz);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', tgz, '-C', work]);
  const to = path.join(__dirname, '..', 'media', 'monaco');
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(path.join(work, 'package', 'min', 'vs'), path.join(to, 'vs'), { recursive: true });
  fs.copyFileSync(path.join(work, 'package', 'LICENSE'), path.join(to, 'LICENSE'));
  // T-SQL needs the editor and its own worker only: the TypeScript, CSS, HTML and JSON language workers stay out (10 MB).
  for (const f of fs.readdirSync(path.join(to, 'vs', 'assets'))) {
    if (/^(ts|css|html|json)\.worker/.test(f)) fs.rmSync(path.join(to, 'vs', 'assets', f));
  }
  // Nor the other languages' code, which Monaco loads only once a model of that language is made: each chunk its
  // registrations name ("../abap-D-t0cyap", "../cssMode-…"), all but SQL's (vsce warned of 116 JavaScript files).
  const vs = path.join(to, 'vs');
  const registrations = [path.join(vs, 'basic-languages', 'monaco.contribution.js'),
    ...fs.readdirSync(path.join(vs, 'language')).map((l) => path.join(vs, 'language', l, 'monaco.contribution.js'))].filter((f) => fs.existsSync(f));
  for (const file of registrations) {
    for (const [, chunk] of fs.readFileSync(file, 'utf8').matchAll(/"\.\.\/(?:\.\.\/)?([A-Za-z0-9_]+-[A-Za-z0-9_-]{8})"/g)) {
      if (!/^sql-/.test(chunk) && fs.existsSync(path.join(vs, `${chunk}.js`))) fs.rmSync(path.join(vs, `${chunk}.js`));
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Monaco ${version} in ${to}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
