// SQL Server Management Studio's own connections: the Connect dialog's history (its Recent Connections), which SSMS 21
// and 22 keep as Registered Servers of the group MruSqlConnectionsGroup in %APPDATA%\Microsoft\SQL Server Management
// Studio\RegSrvr17.xml, each a connection string whose password, when remembered, is the user's DPAPI-protected UTF-16
// in Base64 (Microsoft.SqlServer.Management.RegisteredServers: RegisteredServer.ProtectData, ProtectedData.Unprotect
// with no entropy, CurrentUser). Read only: SSMS's file is never written. And the servers of this machine, as the
// dialog's Browse tab lists them: the instances of the registry and LocalDB's.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { parse, fieldsOf } = require('./sql-connection');

const REGISTERED_SERVERS = path.join(process.env.APPDATA || '', 'Microsoft', 'SQL Server Management Studio', 'RegSrvr17.xml');

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const element = (block, name) => {
  const m = new RegExp(`<RegisteredServers:${name}[^>]*?(?:/>|>([\\s\\S]*?)</RegisteredServers:${name}>)`).exec(block);
  return m ? unxml(m[1] || '') : undefined;
};

/** SSMS's recent connections, newest first (Connection0001 is the last one SSMS connected to), as
 *  { id, fields, connectionString } with the password still protected. */
function recentConnections(file = REGISTERED_SERVERS) {
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found = [];
  for (const m of xml.matchAll(/<RegisteredServers:RegisteredServer\b[^>]*>([\s\S]*?)<\/RegisteredServers:RegisteredServer>/g)) {
    const block = m[1];
    if (!/MruSqlConnectionsGroup/.test(element(block, 'Parent') || '')) continue;
    const connectionString = element(block, 'ConnectionStringWithEncryptedPassword');
    if (!connectionString) continue;
    const fields = fieldsOf(connectionString);
    if (element(block, 'AuthenticationType') === '0') fields.authentication = 'Integrated';
    found.push({ id: element(block, 'Name'), fields, connectionString });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** The password SSMS remembered, unprotected as the user (DPAPI) by Windows PowerShell; it goes through pipes only. */
function unprotect(protectedBase64) {
  return new Promise((resolve, reject) => {
    const script = 'Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadLine()); '
      + "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')))";
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 && out ? resolve(Buffer.from(out.trim(), 'base64').toString('utf16le')) : reject(new Error(err.trim() || `powershell exited with ${code}`))));
    ps.stdin.end(`${protectedBase64}\n`);
  });
}

/** The password SSMS remembered for a recent connection, unprotected; undefined when it remembered none. */
async function rememberedPassword(entry) {
  const protectedPassword = parse(entry.connectionString).find(([k]) => /^(password|pwd)$/i.test(k))?.[1];
  return protectedPassword ? unprotect(protectedPassword) : undefined;
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true }, (e, stdout) => resolve(e ? '' : stdout)));

/** This machine's SQL Server instances (the registry's Instance Names\SQL, as SSMS's local discovery reads it) and
 *  LocalDB's, as SSMS names them: MACHINE or MACHINE\INSTANCE, (localdb)\NAME. */
async function localServers() {
  if (process.platform !== 'win32') return [];
  const machine = os.hostname().toUpperCase();
  const [instances, localdb] = await Promise.all([
    run('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL']),
    run('sqllocaldb.exe', ['info']),
  ]);
  const names = [...instances.matchAll(/^\s+(\S+)\s+REG_SZ/gm)].map((m) => (m[1].toUpperCase() === 'MSSQLSERVER' ? machine : `${machine}\\${m[1]}`));
  const local = localdb.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((n) => `(localdb)\\${n}`);
  return [...names, ...local];
}

module.exports = { recentConnections, rememberedPassword, unprotect, localServers, REGISTERED_SERVERS };
