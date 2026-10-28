// An IISExpress launch profile under IIS Express, as Visual Studio runs it: the site in the solution's
// .vs/<solution>/config/applicationhost.config (VS's own file, which VS and this share), its bindings and its Windows and
// anonymous authentication from launchSettings.json's iisSettings, the project folder's web.config handing requests to
// the ASP.NET Core Module, which starts the built app from LAUNCHER_PATH and LAUNCHER_ARGS, as VS sets them.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const HOME = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'IIS Express');
const EXE = path.join(HOME, 'iisexpress.exe');
const TEMPLATE = path.join(HOME, 'config', 'templates', 'PersonalWebServer', 'applicationhost.config');

/** Whether IIS Express is here to run the profile (CSHARPSHOOTER_NO_IISEXPRESS: as if it were not, for Kestrel). */
const available = () => process.platform === 'win32' && fs.existsSync(EXE) && fs.existsSync(TEMPLATE) && !process.env.CSHARPSHOOTER_NO_IISEXPRESS;

/** The solution above the project (.slnx or .sln); VS keeps its applicationhost.config under .vs/<solution file>/config
 *  for an .slnx, .vs/<solution name>/config for an .sln. Without one, the project's own folder stands in. */
function configFile(project) {
  for (let dir = path.dirname(project); ; dir = path.dirname(dir)) {
    const files = fs.readdirSync(dir);
    const slnx = files.find((f) => /\.slnx$/i.test(f));
    const sln = files.find((f) => /\.sln$/i.test(f));
    if (slnx) return path.join(dir, '.vs', slnx, 'config', 'applicationhost.config');
    if (sln) return path.join(dir, '.vs', path.basename(sln, '.sln'), 'config', 'applicationhost.config');
    if (path.dirname(dir) === dir) break;
  }
  return path.join(path.dirname(project), '.vs', path.basename(project, '.csproj'), 'config', 'applicationhost.config');
}

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Bindings as VS writes them from iisSettings.iisExpress: applicationUrl's port over http, sslPort over https. */
function bindings(iis) {
  const out = [];
  if (iis?.applicationUrl) {
    const u = new URL(iis.applicationUrl);
    out.push({ protocol: u.protocol.replace(':', ''), port: u.port || (u.protocol === 'https:' ? 443 : 80), host: u.hostname });
  }
  if (iis?.sslPort) out.push({ protocol: 'https', port: iis.sslPort, host: 'localhost' });
  return out.map((b) => `                    <binding protocol="${b.protocol}" bindingInformation="*:${b.port}:${attr(b.host)}" />`).join('\n');
}

/** Writes the project's site into applicationhost.config (from IIS Express's template when there is none yet), as VS does
 *  before it starts IIS Express: its app pool, its site at the project folder (the one VS added, found by that folder,
 *  keeps its name and id) with the profile's bindings, and its authentication. Gives the file, site and app pool. */
function writeConfig(project, iisSettings) {
  const file = configFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.readFileSync(TEMPLATE, 'utf8');
  const folder = path.resolve(path.dirname(project));
  const sites = sitesOf(text);
  const mine = sites.find((m) => at(m, folder));
  let name = mine?.[1];
  if (!name) {
    const taken = new Set(sites.map((m) => m[1].toLowerCase()));
    name = path.basename(project, '.csproj');
    for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${path.basename(project, '.csproj')}(${i})`;
  }
  const pool = `${name} AppPool`;
  if (!text.includes(`<add name="${attr(pool)}"`)) {
    text = text.replace(/(\n\s*)<applicationPoolDefaults/, `$1<add name="${attr(pool)}" managedRuntimeVersion="" />$1<applicationPoolDefaults`);
  }
  const id = mine?.[2] || String(Math.max(0, ...sites.map((m) => +m[2])) + 1);
  const site = `<site name="${attr(name)}" id="${id}">
                <application path="/" applicationPool="${attr(pool)}">
                    <virtualDirectory path="/" physicalPath="${attr(folder)}" />
                </application>
                <bindings>
${bindings(iisSettings?.iisExpress)}
                </bindings>
            </site>`;
  text = mine ? text.replace(mine[0], () => site) : text.replace(/(\n\s*)<siteDefaults>/, (m, indent) => `${indent}${site}${m}`);
  const anonymous = iisSettings?.anonymousAuthentication !== false;
  const windows = !!iisSettings?.windowsAuthentication;
  const location = `<location path="${attr(name)}">
        <system.webServer>
            <security>
                <authentication>
                    <anonymousAuthentication enabled="${anonymous}" />
                    <windowsAuthentication enabled="${windows}" />
                </authentication>
            </security>
        </system.webServer>
    </location>`;
  const existing = new RegExp(`<location path="${escape(attr(name))}">[\\s\\S]*?</location>`).exec(text)?.[0];
  if (existing && /<anonymousAuthentication [^>]*\/>/.test(existing) && /<windowsAuthentication [^>]*\/>/.test(existing)) {
    // VS's own location for the site, which may hold more than authentication: only the two switches change.
    text = text.replace(existing, () => existing.replace(/(<anonymousAuthentication [^>]*enabled=")[^"]*/, `$1${anonymous}`).replace(/(<windowsAuthentication [^>]*enabled=")[^"]*/, `$1${windows}`));
  } else {
    text = existing ? text.replace(existing, () => location) : text.replace(/(\s*)<\/configuration>\s*$/, (m) => `\n    ${location}${m}`);
  }
  fs.writeFileSync(file, text.replace(/\r?\n/g, '\r\n')); // CRLF, as VS and the template write it
  return { file, site: name, pool };
}

/** The project folder's web.config, which IIS Express reads for the site: VS writes one when there is none, handing every
 *  request to AspNetCoreModuleV2 in the project's AspNetCoreHostingModel (in-process unless it says otherwise). Gives the
 *  hosting model the module runs it in. */
function webConfig(project, props) {
  const file = path.join(path.dirname(project), 'web.config');
  if (fs.existsSync(file)) {
    const model = /<aspNetCore\b[^>]*\bhostingModel="([^"]*)"/i.exec(fs.readFileSync(file, 'utf8'))?.[1];
    return /^inprocess$/i.test(model || '') ? 'inprocess' : 'outofprocess'; // the module's default, without the attribute
  }
  const model = /^outofprocess$/i.test(props?.AspNetCoreHostingModel || '') ? 'outofprocess' : 'inprocess';
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="%LAUNCHER_PATH%" arguments="%LAUNCHER_ARGS%" stdoutLogEnabled="false" hostingModel="${model === 'inprocess' ? 'InProcess' : 'OutOfProcess'}" />
    </system.webServer>
  </location>
</configuration>
`);
  return model;
}

/** LAUNCHER_PATH and LAUNCHER_ARGS for web.config's %LAUNCHER_PATH% %LAUNCHER_ARGS%: the app's apphost beside its .dll,
 *  else dotnet exec <dll>. */
function launcher(program) {
  const exe = program.replace(/\.dll$/i, '.exe');
  return fs.existsSync(exe) ? { LAUNCHER_PATH: exe, LAUNCHER_ARGS: '' } : { LAUNCHER_PATH: 'dotnet', LAUNCHER_ARGS: `exec "${program}"` };
}

const powershell = (script) => new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (e, stdout) => resolve(stdout || '')));

/** applicationhost.config's sites: [whole element, name, id]. */
const sitesOf = (text) => [...text.matchAll(/<site name="([^"]*)" id="(\d+)"[^>]*>[\s\S]*?<\/site>/g)];

/** Whether a site's root is the folder (VS's physicalPath, with or without a trailing backslash). */
function at(site, folder) {
  const root = /<application path="\/"[^>]*>\s*<virtualDirectory path="\/" physicalPath="([^"]*)"/.exec(site[0])?.[1];
  return !!root && path.resolve(root.replace(/&amp;/g, '&')).toLowerCase() === path.resolve(folder).toLowerCase();
}

/** The site applicationhost.config has for the project folder, or undefined. */
const siteOf = (file, folder) => (fs.existsSync(file) ? sitesOf(fs.readFileSync(file, 'utf8')).find((m) => at(m, folder))?.[1] : undefined);

/** Stops the IIS Express running the project's site (a start before, VS's, or one VS Code left going) and waits until it
 *  has gone, so a build can write what its in-process app holds; gives the ids. */
async function stopFor(project) {
  const file = configFile(project);
  const site = siteOf(file, path.dirname(project));
  if (!site) return [];
  const quote = (v) => `'${v.replace(/'/g, "''")}'`;
  const out = await powershell(`$c = ${quote(file.toLowerCase())}; $s = '/site:"?' + [regex]::Escape(${quote(site)}) + '"?(\\s|$)'
$p = @(Get-CimInstance Win32_Process -Filter "Name='iisexpress.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($c) -and $_.CommandLine -match $s })
$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$p | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 15 -ErrorAction SilentlyContinue; $_.ProcessId }`);
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/** The app IIS Express started out of process (the module's child of iisexpress.exe), once a request has started it. */
async function child(pid) {
  const out = await powershell(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${+pid}" | Where-Object { $_.Name -ne 'conhost.exe' } | Select-Object -First 1).ProcessId`);
  return +out.trim() || undefined;
}

/** A request with the Windows user's credentials (curl's Negotiate, as a browser signs in), which makes the module start
 *  the app; gives whether it was answered. */
function request(url) {
  return new Promise((resolve) => execFile('curl.exe', ['-s', '-k', '-o', 'NUL', '--negotiate', '-u', ':', '--max-time', '300', url], { windowsHide: true }, (e) => resolve(!e)));
}

module.exports = { EXE, available, configFile, writeConfig, webConfig, launcher, stopFor, child, request };
