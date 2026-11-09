// A web project's files as the app serves them, for the editor's help in its markup (css-classes.js) and its JS interop
// (js-interop.js): the project a file is of, those that reference it, and the file an address names, from the app's
// wwwroot, a referenced project's or a package's static web assets (_content/<id>/…), or beside a component (collocated JS).
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.vscode']);
const same = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** The project file of the folder a file is in, or of the nearest one above it holding one; null for none. */
function projectOf(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let found;
    try { found = fs.readdirSync(dir).find((f) => /\.(cs|fs|vb)proj$/i.test(f)); } catch { /* not readable */ }
    if (found) return path.join(dir, found);
    if (path.dirname(dir) === dir) return null;
  }
}

/** The files under a folder whose names a test passes, its build's, packages' and tools' folders passed over. */
function filesUnder(dir, test, out = [], depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name.toLowerCase()) && depth < 12) filesUnder(path.join(dir, e.name), test, out, depth + 1);
    } else if (test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** The projects a project references (ProjectReference), read from its file. */
function referencesOf(project) {
  let text;
  try { text = fs.readFileSync(project, 'utf8'); } catch { return []; }
  return [...text.matchAll(/<ProjectReference\s+Include\s*=\s*"([^"]+)"/gi)]
    .map((m) => path.resolve(path.dirname(project), m[1].replace(/\\/g, path.sep))).filter((p) => fs.existsSync(p));
}

/** A project and those it references, through others too. */
function referencedFrom(project, seen = new Set()) {
  if (seen.has(project)) return [...seen];
  seen.add(project);
  for (const r of referencesOf(project)) referencedFrom(r, seen);
  return [...seen];
}

/** A project and those that reference it, through others too, among the given projects. */
function referencingTo(project, projects) {
  const found = new Set([project]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of projects) {
      if (!found.has(p) && referencesOf(p).some((r) => found.has(r))) {
        found.add(p);
        grew = true;
      }
    }
  }
  return [...found];
}

const projectName = (project) => path.basename(project).replace(/\.(cs|fs|vb)proj$/i, '');

/** The packages a project's restore resolved, by id (lower case): their folders. */
function packagesOf(project) {
  let assets;
  try { assets = JSON.parse(fs.readFileSync(path.join(path.dirname(project), 'obj', 'project.assets.json'), 'utf8')); } catch { return new Map(); }
  const folders = Object.keys(assets.packageFolders || {});
  const found = new Map();
  for (const [key, library] of Object.entries(assets.libraries || {})) {
    if (library.type !== 'package' || !library.path) continue;
    const folder = folders.map((f) => path.join(f, library.path)).find((f) => fs.existsSync(f));
    if (folder) found.set(key.split('/')[0].toLowerCase(), folder);
  }
  return found;
}

/** An address's path from the app's root: its query, fragment, escapes and leading ~/, ./ or / taken off. */
function appPath(href) {
  let p = href.replace(/[?#].*$/, '').replace(/^~?\.?\//, '').replace(/^\/+/, '');
  try { p = decodeURIComponent(p); } catch { /* as written */ }
  return p;
}

/** The file an address names as the project serving it serves it; null where none is found. `_content/<id>/…` is a
 *  referenced project's wwwroot, or a package's static web assets; else the project's wwwroot, or its own folder (a
 *  component's collocated .razor.js). */
function assetFile(project, href) {
  const p = appPath(href);
  if (!p || /^[a-z]+:/i.test(p)) return null;
  const content = /^_content\/([^/]+)\/(.+)$/i.exec(p);
  if (content) {
    const [, id, rest] = content;
    const own = referencedFrom(project).find((r) => same(projectName(r), id));
    if (own) return existing(path.join(path.dirname(own), 'wwwroot', rest));
    const folder = packagesOf(project).get(id.toLowerCase());
    return folder ? existing(path.join(folder, 'staticwebassets', rest)) : null;
  }
  const dir = path.dirname(project);
  return existing(path.join(dir, 'wwwroot', p)) || existing(path.join(dir, p));
}

const existing = (file) => {
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
};

module.exports = { projectOf, filesUnder, referencesOf, referencedFrom, referencingTo, projectName, assetFile, appPath, same };
