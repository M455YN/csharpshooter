// F5 without a build when nothing changed, as Passenger 0.2.1 launches and as VS's fast up-to-date check skips one: a
// project whose files, its references' and what MSBuild finds above them are as its last build here left them, under the
// same SDK and settings, and whose outputs are that build's, starts with no dotnet build. Stamps are taken after the build,
// not before it as Passenger takes them, since a project's own targets may rewrite its sources as it builds (a web
// project's gulp copies its shared views, a library writes BuildDate.txt); a file a build rewrote is compared by its content, so the
// same copy again is no change. A file saved during the build, or anything this cannot account for, builds next time.
// What a build left is kept for this window alone, so an editor started again builds first.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const builds = new Map(); // key -> { reads: Map(lower path -> stamp), made: [stamp], props }

// Folders no build reads from (its own outputs, packages, the editor's and version control's), and files only the IDE writes
// (the .csproj.user with the active launch profile, launchSettings.json, which dotnet run alone reads).
const SKIPPED_FOLDERS = /^(bin|obj|node_modules|\..*)$/i;
const ignored = (file) => /\.user$/i.test(file) || /[\\/]Properties[\\/]launchSettings\.json$/i.test(file) || /^(thumbs\.db|\.ds_store)$/i.test(path.basename(file));
// What MSBuild and the SDK read beside or above a project: Directory.Build.*, Directory.Packages.props, other imports,
// global.json (the SDK's version), NuGet.config, a response file.
const ABOVE = /(\.props|\.targets|\.rsp|^global\.json|^nuget\.config)$/i;

function stamp(file) {
  try {
    const s = fs.statSync(file);
    return { path: file, size: s.size, mtime: s.mtimeMs };
  } catch {
    return { path: file, size: -1, mtime: 0 }; // gone, or not there yet: one that comes is a change
  }
}

const hash = (file) => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

function walk(dir, reads) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIPPED_FOLDERS.test(e.name)) walk(full, reads);
    } else if (e.isFile() && !ignored(full)) {
      reads.set(full.toLowerCase(), stamp(full));
    }
  }
}

const withoutComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

/** The project and every project it references, in turn; or why a build of it reads what this cannot follow. */
function projects(project) {
  const all = [path.resolve(project)];
  const imports = [];
  for (let i = 0; i < all.length; i++) {
    let text;
    try {
      text = withoutComments(fs.readFileSync(all[i], 'utf8'));
    } catch {
      return { unknown: `${path.basename(all[i])} cannot be read` };
    }
    // DisableFastUpToDateCheck is passed over: VS's own check alone reads it, and a project sets it for its build steps to
    // run every time (a library's build date), which a launch with nothing changed has no need of.
    for (const [, include] of text.matchAll(/<ProjectReference\s[^>]*Include="([^"]+)"/gi)) {
      if (/[$*%@]/.test(include)) return { unknown: `${path.basename(all[i])} references ${include}` };
      const reference = path.resolve(path.dirname(all[i]), include.replace(/\\/g, path.sep));
      if (!all.some((p) => p.toLowerCase() === reference.toLowerCase())) all.push(reference);
    }
    // An import from elsewhere than the folders below: followed when its path is plain, or relative to its own file.
    for (const [, imported] of text.matchAll(/<Import\s[^>]*Project="([^"]+)"/gi)) {
      const plain = imported.replace(/\$\((MSBuildThisFileDirectory|MSBuildProjectDirectory)\)/g, path.dirname(all[i]) + path.sep);
      if (/[$*%@]/.test(plain)) return { unknown: `${path.basename(all[i])} imports ${imported}` };
      imports.push(path.resolve(path.dirname(all[i]), plain.replace(/\\/g, path.sep)));
    }
  }
  return { all, imports };
}

/** The Git repository over a folder: its HEAD and the branch it names, which the SDK stamps the assembly with. */
function repository(folder, reads) {
  for (let at = folder; ; at = path.dirname(at)) {
    const dotGit = path.join(at, '.git');
    let git = null;
    try {
      git = fs.statSync(dotGit).isDirectory() ? dotGit : path.resolve(at, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))[1].trim());
    } catch {
      // none here; the folder above, until the root
    }
    if (git) {
      const head = path.join(git, 'HEAD');
      let common = git;
      try {
        common = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim());
      } catch {
        // a repository's own .git, no worktree's
      }
      for (const file of [head, path.join(common, 'packed-refs')]) reads.set(file.toLowerCase(), stamp(file));
      try {
        const ref = /^ref:\s*(.+)$/m.exec(fs.readFileSync(head, 'utf8'));
        if (ref) reads.set(path.join(common, ref[1].trim()).toLowerCase(), stamp(path.join(common, ref[1].trim())));
      } catch {
        // a detached HEAD names its commit itself
      }
      return;
    }
    if (path.dirname(at) === at) return;
  }
}

/** Everything a build of the project reads, stamped now; or why it cannot be said. */
function inputs(project) {
  const found = projects(project);
  if (found.unknown) return found;
  const reads = new Map();
  const above = new Set();
  for (const p of found.all) {
    walk(path.dirname(p), reads);
    reads.set(p.toLowerCase(), stamp(p)); // also where it lies outside a folder walked (one not there is a change)
    for (let at = path.dirname(path.dirname(p)); !above.has(at.toLowerCase()); at = path.dirname(at)) {
      above.add(at.toLowerCase());
      let names = [];
      try {
        names = fs.readdirSync(at);
      } catch {
        // unreadable: nothing of it read
      }
      for (const name of names.filter((n) => ABOVE.test(n))) reads.set(path.join(at, name).toLowerCase(), stamp(path.join(at, name)));
      if (path.dirname(at) === at) break;
    }
    repository(path.dirname(p), reads);
  }
  for (const file of found.imports) reads.set(file.toLowerCase(), stamp(file));
  return { reads, folders: found.all.map((p) => path.dirname(p).toLowerCase()) };
}

/** The SDK a build in the project's folder runs under, as its global.json picks it. */
function sdkVersion(project) {
  return new Promise((resolve) => {
    execFile('dotnet', ['--version'], { cwd: path.dirname(project), windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

const same = (a, b) => !!a && !!b && a.size === b.size && a.mtime === b.mtime;

/** Whether a file is as a build left it: the same stamp, or, for one that build rewrote, the same bytes. */
function holds(was, now) {
  if (same(was, now)) return true;
  return !!was.hash && was.size === now.size && hash(now.path) === was.hash;
}

/** Before a build: what it would read now, its key, and whether its last build here still stands (with what that build's
 *  launch read of the project, so a start that builds nothing asks MSBuild nothing either). */
async function check(project, settings, framework) {
  const sdk = await sdkVersion(project);
  const now = inputs(project);
  const key = [sdk, path.resolve(project).toLowerCase(), settings.configuration, settings.platform || '', framework || ''].join('\n');
  if (!sdk || now.unknown) return { key, unknown: now.unknown || 'the SDK did not say its version', holds: false };
  const last = builds.get(key);
  const stands = !!last && last.reads.size === now.reads.size
    && [...now.reads].every(([file, s]) => last.reads.has(file) && holds(last.reads.get(file), s))
    && last.made.length > 0 && last.made.every((m) => same(m, stamp(m.path)));
  return { key, project, reads: now.reads, folders: now.folders, holds: stands, props: stands ? last.props : undefined };
}

/** After a build that succeeded: what it reads now (the files it rewrote with their bytes' hash) and the files it listed as
 *  written to its output folder, kept as the state a next start compares with. Nothing is kept when it listed none. */
function built(checked, props) {
  builds.delete(checked.key);
  if (!checked.reads || !props?.IntermediateOutputPath || !props.TargetPath) return false;
  const now = inputs(checked.project);
  if (now.unknown) return false;
  for (const [file, s] of now.reads) {
    if (!same(checked.reads.get(file), s) && s.size >= 0) s.hash = hash(s.path);
  }
  const folder = path.dirname(props.TargetPath).toLowerCase() + path.sep;
  const listed = path.resolve(path.dirname(checked.project), props.IntermediateOutputPath, props.CleanFile || `${path.basename(checked.project)}.FileListAbsolute.txt`);
  let made;
  try {
    made = fs.readFileSync(listed, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && path.resolve(l).toLowerCase().startsWith(folder));
  } catch {
    return false;
  }
  if (!made.length) return false;
  builds.set(checked.key, { reads: now.reads, made: made.map(stamp), props });
  return true;
}

/** Whether a saved file is one a check read (under a project's folder of it): that build no longer stands for it. */
const reads = (checked, file) => !!checked.folders?.some((f) => file.toLowerCase().startsWith(f + path.sep));

function forget(checked) {
  if (checked?.key) builds.delete(checked.key);
}

module.exports = { check, built, forget, reads, inputs };
