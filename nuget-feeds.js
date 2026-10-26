// What the NuGet page asks package sources and nuget.config: the enabled sources and their names, a search over one or
// all of them (a v3 feed's search service, or a local folder's .nupkg files read here), a package's versions with their
// licence, dependencies, deprecation and advisories (a v3 feed's registration, or the folder's .nuspec), its README, and
// the package source mapping, which a package installed from a source is added to as VS adds it.
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { execFile } = require('child_process');

const dotnet = (args, cwd) => new Promise((resolve) => execFile('dotnet', args, { cwd, windowsHide: true, maxBuffer: 16 << 20 }, (error, stdout) => resolve(error ? '' : stdout)));
const isFolder = (source) => !/^https?:/i.test(source);
const sameSource = (a, b) => (isFolder(a) && isFolder(b) ? path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase() : a === b);

/** The enabled sources with their names, as dotnet nuget list source gives them for this folder (its nuget.config
 *  files): [{ name, url }]. Its words are the CLI's language; the shape ("1.  name [Enabled]", the address under it) is not. */
async function listSources(folder, enabled) {
  const said = (await dotnet(['nuget', 'list', 'source'], folder)).split(/\r?\n/);
  const named = [];
  for (let i = 0; i < said.length; i++) {
    const m = /^\s*\d+\.\s+(.+?)\s+\[[^\]]+\]\s*$/.exec(said[i]);
    if (m && said[i + 1]) named.push({ name: m[1], url: said[i + 1].trim() });
  }
  return enabled ? enabled.map((url) => ({ url, name: named.find((n) => sameSource(n.url, url))?.name || url })) : named;
}

// ---- local folders: .nupkg files, flat (x.1.0.0.nupkg) or as NuGet lays them out (x/1.0.0/x.1.0.0.nupkg, x.nuspec beside it)

/** The files of a .nupkg (a zip) by name, each read on demand. */
function zipEntries(file) {
  const zip = fs.readFileSync(file);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return new Map();
  const count = zip.readUInt16LE(end + 10);
  const entries = new Map();
  for (let i = 0, at = zip.readUInt32LE(end + 16); i < count && zip.readUInt32LE(at) === 0x02014b50; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      // a name with a stray % is its own
    }
    entries.set(decoded.toLowerCase(), () => {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    });
    at += 46 + nameLength + skip;
  }
  return entries;
}

const unxml = (s) => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

/** A package's details from its .nuspec, in the shape a v3 feed gives them. */
function readNuspec(xml, zip) {
  const one = (tag) => unxml(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)?.[1]);
  const license = /<license\b[^>]*type="(\w+)"[^>]*>([^<]*)</i.exec(xml);
  const dependencies = [];
  const deps = /<dependencies>([\s\S]*?)<\/dependencies>/i.exec(xml)?.[1] || '';
  const groups = [...deps.matchAll(/<group\b([^>]*?)(?:\/>|>([\s\S]*?)<\/group>)/gi)];
  for (const g of groups.length ? groups : [[deps, '', deps]]) {
    dependencies.push({
      framework: /targetFramework="([^"]*)"/i.exec(g[1])?.[1] || '',
      packages: [...(g[2] || '').matchAll(/<dependency\b[^>]*id="([^"]+)"[^>]*?(?:version="([^"]*)")?[^>]*\/?>/gi)].map((d) => ({ id: d[1], range: d[2] || '' })),
    });
  }
  // An icon packed in the package becomes a data: address the page can show.
  const icon = one('icon');
  let iconUrl = one('iconUrl');
  if (icon && zip?.has(icon.replace(/\\/g, '/').toLowerCase())) {
    const type = /\.png$/i.test(icon) ? 'image/png' : /\.svg$/i.test(icon) ? 'image/svg+xml' : 'image/jpeg';
    iconUrl = `data:${type};base64,${zip.get(icon.replace(/\\/g, '/').toLowerCase())().toString('base64')}`;
  }
  return {
    id: one('id'), version: one('version'), authors: one('authors'), description: one('description'), projectUrl: one('projectUrl'),
    tags: one('tags').split(/\s+/).filter(Boolean), iconUrl,
    licenseExpression: license?.[1] === 'expression' ? unxml(license[2]) : '', licenseUrl: one('licenseUrl'),
    requireLicenseAcceptance: /^true$/i.test(one('requireLicenseAcceptance')), dependencies, readmeFile: one('readme'),
  };
}

const folderIndexes = new Map(); // folder -> Map(id lower -> [{ version, nupkg, nuspec }])
/** The packages a folder holds, by id; read once, until refresh. */
function folderIndex(folder) {
  if (folderIndexes.has(folder)) return folderIndexes.get(folder);
  const index = new Map();
  const add = (nupkg, nuspec) => {
    const m = /^(.+?)\.(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?)\.nupkg$/i.exec(path.basename(nupkg));
    if (!m) return;
    const key = m[1].toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ id: m[1], version: m[2], nupkg, nuspec });
  };
  const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  for (const entry of list(folder)) {
    if (entry.isFile() && entry.name.endsWith('.nupkg')) add(path.join(folder, entry.name));
    if (!entry.isDirectory()) continue;
    for (const version of list(path.join(folder, entry.name)).filter((v) => v.isDirectory())) {
      const dir = path.join(folder, entry.name, version.name);
      const files = list(dir).map((f) => f.name);
      const nupkg = files.find((f) => f.toLowerCase().endsWith('.nupkg'));
      if (nupkg) add(path.join(dir, nupkg), files.find((f) => f.toLowerCase().endsWith('.nuspec')) && path.join(dir, files.find((f) => f.toLowerCase().endsWith('.nuspec'))));
    }
  }
  folderIndexes.set(folder, index);
  return index;
}

/** One version of a folder's package: its .nuspec (beside it, else inside the .nupkg) read, with the .nupkg's files. */
function folderPackage(entry) {
  if (!entry.read) {
    let zip;
    try {
      zip = zipEntries(entry.nupkg);
      const inner = [...zip.keys()].find((k) => k.endsWith('.nuspec') && !k.includes('/'));
      const xml = entry.nuspec ? fs.readFileSync(entry.nuspec, 'utf8') : inner ? zip.get(inner)().toString('utf8') : '';
      entry.read = { ...readNuspec(xml, zip), zip };
    } catch {
      entry.read = { id: entry.id, version: entry.version, tags: [], dependencies: [] };
    }
  }
  return entry.read;
}

const sortVersions = (versions, compare) => [...versions].sort(compare);

/** A folder's packages for a query, in a search service's shape. */
function searchFolder(folder, query, prerelease, take, compare) {
  const q = query.toLowerCase().replace(/^packageid:/, '');
  const exact = query.toLowerCase().startsWith('packageid:');
  const found = [];
  for (const [key, entries] of folderIndex(folder)) {
    if (exact ? key !== q : q && !key.includes(q)) continue;
    const offered = sortVersions(entries.filter((e) => prerelease || !e.version.includes('-')), (a, b) => compare(a.version, b.version));
    if (!offered.length) continue;
    const latest = folderPackage(offered.at(-1));
    found.push({ ...latest, id: latest.id || offered.at(-1).id, version: offered.at(-1).version, versions: offered.map((e) => ({ version: e.version })), authors: latest.authors });
    if (found.length >= take) break;
  }
  return found;
}

// ---- v3 feeds

const indexes = new Map(); // feed -> its service index's resources, or null
async function resource(source, ...types) {
  if (!indexes.has(source)) {
    indexes.set(source, fetch(source).then((r) => r.json()).then((j) => j.resources || []).catch(() => null));
  }
  const resources = await indexes.get(source);
  for (const type of types) {
    const found = resources?.find((r) => r['@type'] === type || r['@type'].startsWith(`${type}/`));
    if (found) return found['@id'];
  }
  return undefined;
}

/** Packages a source finds for a query, as a v3 search service gives them (id, version, description, authors, iconUrl,
 *  versions, totalDownloads, projectUrl, tags); a folder's from its files; undefined when the source can do neither. */
async function search(source, query, prerelease, take, compare) {
  if (isFolder(source)) return fs.existsSync(source) ? searchFolder(source, query, prerelease, take, compare) : undefined;
  const service = await resource(source, 'SearchQueryService/3.5.0', 'SearchQueryService');
  if (!service) return undefined;
  const url = new URL(service);
  url.searchParams.set('q', query);
  url.searchParams.set('prerelease', String(!!prerelease));
  url.searchParams.set('semVerLevel', '2.0.0');
  url.searchParams.set('take', String(take));
  return (await (await fetch(url)).json()).data || [];
}

/** A search over several sources at once (VS's "All"): each package once, from the first source that has it, with every
 *  source's versions. */
async function searchAll(sources, query, prerelease, take, compare) {
  const answers = await Promise.all(sources.map((s) => search(s, query, prerelease, take, compare).catch(() => undefined)));
  if (answers.every((a) => a === undefined)) return undefined;
  const merged = new Map();
  for (const answer of answers) {
    for (const x of answer || []) {
      const key = x.id.toLowerCase();
      const known = merged.get(key);
      if (!known) merged.set(key, { ...x, versions: [...(x.versions || [])] });
      else for (const v of x.versions || []) if (!known.versions.some((k) => k.version === v.version)) known.versions.push(v);
    }
  }
  return [...merged.values()].slice(0, take);
}

/** A package's versions with what VS shows of each: { version: { published, licenseExpression, licenseUrl,
 *  requireLicenseAcceptance, dependencies, deprecation, vulnerabilities, readmeUrl, ... } }, from the first source that
 *  knows it. */
async function versionsOf(sources, id, compare) {
  const out = {};
  for (const source of sources) {
    try {
      if (isFolder(source)) {
        for (const entry of folderIndex(source).get(id.toLowerCase()) || []) {
          const read = folderPackage(entry);
          out[entry.version] ||= { ...read, version: entry.version, folderEntry: entry };
        }
        continue;
      }
      const base = await resource(source, 'RegistrationsBaseUrl/3.6.0', 'RegistrationsBaseUrl/3.4.0', 'RegistrationsBaseUrl');
      if (!base) continue;
      const response = await fetch(`${base.replace(/\/?$/, '/')}${id.toLowerCase()}/index.json`);
      if (!response.ok) continue;
      const readme = await resource(source, 'ReadmeUriTemplate/6.13.0');
      for (const page of (await response.json()).items || []) {
        const items = page.items || (await (await fetch(page['@id'])).json()).items || [];
        for (const { catalogEntry: e } of items) {
          if (out[e.version]) continue;
          out[e.version] = {
            id: e.id, version: e.version, published: e.published && !e.published.startsWith('1900') ? e.published : '', authors: e.authors,
            description: e.description, projectUrl: e.projectUrl, tags: [].concat(e.tags || []), iconUrl: e.iconUrl,
            licenseExpression: e.licenseExpression || '', licenseUrl: e.licenseUrl || '', requireLicenseAcceptance: !!e.requireLicenseAcceptance,
            dependencies: (e.dependencyGroups || []).map((g) => ({ framework: g.targetFramework || '', packages: (g.dependencies || []).map((d) => ({ id: d.id, range: d.range || '' })) })),
            deprecation: e.deprecation ? { reasons: e.deprecation.reasons || [], message: e.deprecation.message || '', alternate: e.deprecation.alternatePackage ? { id: e.deprecation.alternatePackage.id, range: e.deprecation.alternatePackage.range || '' } : null } : null,
            vulnerabilities: (e.vulnerabilities || []).map((v) => ({ severity: Number(v.severity), url: v.advisoryUrl })),
            readmeUrl: readme ? readme.replace('{lower_id}', e.id.toLowerCase()).replace('{lower_version}', e.version.toLowerCase()) : '',
          };
        }
      }
    } catch {
      // A source that does not answer leaves the others.
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compare(a, b)));
}

/** A version's README text (Markdown), or '' when it has none. */
async function readmeOf(details) {
  try {
    if (details.folderEntry) {
      const file = details.readmeFile?.replace(/\\/g, '/').toLowerCase();
      return file && details.zip?.has(file) ? details.zip.get(file)().toString('utf8') : '';
    }
    if (!details.readmeUrl) return '';
    const response = await fetch(details.readmeUrl);
    return response.ok ? await response.text() : '';
  } catch {
    return '';
  }
}

// ---- nuget.config: the sources and the package source mapping

const attr = (tag, name) => unxml(new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1]);

/** The nuget.config files in effect for a folder (nearest first, as dotnet nuget config paths lists them), the enabled
 *  sources they make ({ name, url }, a folder's path made absolute against its config) and their package source mapping
 *  ({ mapping: Map(source name -> [patterns]), file: the nearest config with a mapping }). NuGet reads the farthest first;
 *  a nearer one adds, replaces or <clear />s. Read here rather than by dotnet nuget list source, which takes seconds. */
async function readConfigs(folder) {
  const files = (await dotnet(['nuget', 'config', 'paths'], folder)).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && fs.existsSync(l));
  const sources = new Map(); // key -> address
  const disabled = new Set();
  const mapping = new Map();
  let file;
  for (const config of [...files].reverse()) {
    const xml = fs.readFileSync(config, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const section = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1];
    for (const m of (section('packageSources') || '').matchAll(/<(clear|add|remove)\b([^>]*)>/gi)) {
      const key = attr(m[2], 'key');
      if (m[1].toLowerCase() === 'clear') sources.clear();
      else if (m[1].toLowerCase() === 'remove') sources.delete(key);
      else if (key && attr(m[2], 'value')) {
        const value = attr(m[2], 'value');
        sources.set(key, /^https?:/i.test(value) ? value : path.resolve(path.dirname(config), value.replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all)));
      }
    }
    for (const m of (section('disabledPackageSources') || '').matchAll(/<(clear|add)\b([^>]*)>/gi)) {
      if (m[1].toLowerCase() === 'clear') disabled.clear();
      else if (/^true$/i.test(attr(m[2], 'value'))) disabled.add(attr(m[2], 'key'));
      else disabled.delete(attr(m[2], 'key'));
    }
    const mapped = section('packageSourceMapping');
    if (mapped === undefined) continue;
    file = config;
    if (/<clear\s*\/>/i.test(mapped)) mapping.clear();
    for (const m of mapped.matchAll(/<packageSource\b[^>]*key="([^"]+)"[^>]*>([\s\S]*?)<\/packageSource>/gi)) {
      const patterns = [...m[2].matchAll(/<package\b[^>]*pattern="([^"]+)"/gi)].map((p) => p[1]);
      mapping.set(m[1], [...(mapping.get(m[1]) || []), ...patterns]);
    }
  }
  return {
    files, file, mapping, on: [...mapping.values()].some((p) => p.length),
    sources: [...sources].filter(([key]) => !disabled.has(key)).map(([name, url]) => ({ name, url })),
  };
}

/** The sources a package id is mapped to: the longest matching pattern wins, as NuGet matches them ("Contoso.*", "*"). */
function mappedSources(mapping, id) {
  let best = -1;
  let sources = [];
  for (const [source, patterns] of mapping) {
    for (const pattern of patterns) {
      const lower = pattern.toLowerCase();
      const matches = lower.endsWith('*') ? id.toLowerCase().startsWith(lower.slice(0, -1)) : id.toLowerCase() === lower;
      const weight = lower.endsWith('*') ? lower.length - 1 : lower.length + 1000;
      if (!matches) continue;
      if (weight > best) [best, sources] = [weight, [source]];
      else if (weight === best) sources.push(source);
    }
  }
  return sources;
}

/** Maps a package id to a source in the config that holds the mapping, as VS does when it installs an unmapped package. */
function addMapping(file, sourceName, id) {
  let xml = fs.readFileSync(file, 'utf8');
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const source = new RegExp(`(<packageSource\\b[^>]*key="${sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)([\\s\\S]*?)([ \\t]*)</packageSource>`, 'i');
  if (source.test(xml)) {
    xml = xml.replace(source, (all, open, body, indent) => `${open}${body}${indent}  <package pattern="${esc(id)}" />${eol}${indent}</packageSource>`);
  } else {
    xml = xml.replace(/([ \t]*)<\/packageSourceMapping>/i, (all, indent) => `${indent}  <packageSource key="${esc(sourceName)}">${eol}${indent}    <package pattern="${esc(id)}" />${eol}${indent}  </packageSource>${eol}${all}`);
  }
  fs.writeFileSync(file, xml);
}

module.exports = { listSources, search, searchAll, versionsOf, readmeOf, readConfigs, mappedSources, addMapping, isFolder, folderIndexes, zipEntries, readNuspec };
