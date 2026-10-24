// Solution Explorer's search, after Visual Studio's: a box above the tree (Ctrl+;) that filters the tree to the items
// whose names match, from an index kept in memory; "Szukaj w zawartościach plików" adds the files whose text has it
// (ripgrep, the one the editor ships), with the lines under them.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const { readSolution } = require('./solution');

const HIDDEN_DIRS = new Set(['bin', 'obj', 'node_modules', '.vs', '.git']);
const T = {
  placeholder: 'Przeszukaj: Solution Explorer (Ctrl+;)',
  fileContents: 'Szukaj w zawartościach plików',
  fileContentsTip: 'Dołącz zawartości plików do wyników wyszukiwania',
  noResults: 'Brak wyników.',
  tooMany: 'Zbyt wiele wyników do wyświetlenia. Spróbuj uściślić swoje kryteria wyszukiwania.',
  searchingContents: 'Przeszukiwanie zawartości plików…',
  found: 'Pasujące elementy',
  lines: 'wiersze',
  noRipgrep: 'Nie znaleziono ripgrep (rg) edytora: zawartość plików nie jest przeszukiwana.',
};
const MAX_NAME_HITS = 2000;
const BINARY = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'tif', 'tiff', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'bcmap', 'pdf',
  'zip', '7z', 'dll', 'exe', 'pdb', 'nupkg', 'mp3', 'mp4', 'wav', 'xlsx', 'docx', 'pptx', 'map'];
const MAX_LINE_HITS = 2000;

/** Every item of the solution's tree that has a name: projects, their folders and files, as the tree shows them; kept up
 *  to date as VS keeps its index, by the items added and removed (add, remove) rather than built anew. */
async function buildIndex(solutionFile) {
  const entries = [];
  const walk = async (dir, project) => {
    let list;
    try {
      list = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (HIDDEN_DIRS.has(e.name.toLowerCase())) continue;
        entries.push({ name: e.name, path: full, project });
        await walk(full, project);
      } else if (e.isFile() && !e.name.endsWith('.user') && !/\.(cs|vb|fs)proj$/i.test(e.name)) {
        entries.push({ name: e.name, path: full, project });
      }
    }
  };
  const projects = [];
  const collect = (node) => {
    projects.push(...node.projects);
    node.folders.forEach(collect);
  };
  collect(readSolution(solutionFile));
  for (const p of projects) {
    entries.push({ name: path.basename(p, path.extname(p)), path: p, project: p });
    await walk(path.dirname(p), p);
  }
  const remove = (p) => {
    const key = p.toLowerCase();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i].path.toLowerCase();
      if (e === key || e.startsWith(key + path.sep)) entries.splice(i, 1);
    }
  };
  const add = async (p) => {
    remove(p);
    // The innermost project whose folder holds it; none, or under a folder the tree hides: not in the tree.
    const project = projects.filter((x) => p.toLowerCase().startsWith(path.dirname(x).toLowerCase() + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (!project || path.relative(path.dirname(project), p).split(path.sep).some((x) => x.startsWith('.') || HIDDEN_DIRS.has(x.toLowerCase()))) return;
    let stat;
    try {
      stat = await fs.promises.stat(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ name: path.basename(p), path: p, project });
      await walk(p, project);
    } else if (!p.endsWith('.user') && !/\.(cs|vb|fs)proj$/i.test(p)) {
      entries.push({ name: path.basename(p), path: p, project });
    }
  };
  return { entries, projects, add, remove };
}

/** VS's terms: words, or "quoted phrases". */
function terms(query) {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] || m[2]);
}

/** As VS's HierarchySearchMatchEvaluator: every term in the name; case counts only when a term has a capital; a single
 *  all-capitals term also matches the name's letters in order (HC -> HomeController). Returns the matched ranges or null. */
function matcher(query) {
  const list = terms(query);
  if (!list.length) return () => null;
  const matchCase = list.some((t) => /\p{Lu}/u.test(t));
  const camel = list.length === 1 && [...list[0]].every((c) => /\p{Lu}/u.test(c));
  const fold = (s) => (matchCase ? s : s.toLowerCase());
  return (name) => {
    const text = fold(name);
    const ranges = [];
    for (const t of list) {
      const at = text.indexOf(fold(t));
      if (at >= 0) {
        ranges.push([at, at + t.length]);
        continue;
      }
      if (!camel) return null;
      let from = 0;
      for (const c of t) {
        const i = name.indexOf(c, from);
        if (i < 0) return null;
        ranges.push([i, i + 1]);
        from = i + 1;
      }
    }
    return ranges;
  };
}

// The ripgrep the editor ships (as swiftfind finds it): VS Code's @vscode/ripgrep, newer builds' ripgrep-universal.
function ripgrepPath() {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const universal = path.join('@vscode', 'ripgrep-universal', 'bin', `${process.platform}-${process.arch}`, exe);
  return [
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', universal),
    path.join(vscode.env.appRoot, 'node_modules', universal),
  ].find((p) => fs.existsSync(p));
}

/** Lines of the projects' files that hold the query (literal; case as VS: only when it has a capital), at most `max`. */
function grep(rg, query, dirs, cwd, max) {
  const args = ['--no-config', '--no-ignore', '--fixed-strings', '--smart-case', '--line-number', '--no-heading', '--color', 'never',
    '--max-columns', '300', '--max-columns-preview', '--max-filesize', '2M',
    ...['bin', 'obj', 'node_modules', '.vs', '.git'].flatMap((d) => ['--glob', `!**/${d}/**`]),
    '--glob', '!*.user', '--glob', '!*.*proj',
    // Files with no text to find: not opened at all (on Windows opening a file costs more than reading it).
    '--glob', `!*.{${BINARY.join(',')}}`, '--regexp', query, '--', ...dirs];
  const child = childProcess.spawn(rg, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise((resolve) => {
    const hits = [];
    let rest = '';
    let full = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const l of lines) {
        // path:line:text; the path may start with a drive (D:) when a project is on another drive than the solution.
        const m = /^((?:[A-Za-z]:)?[^:]*):(\d+):(.*)$/.exec(l);
        if (!m) continue;
        if (hits.length >= max) {
          full = true;
          child.kill();
          break;
        }
        hits.push({ file: path.resolve(cwd, m[1]), line: Number(m[2]), text: m[3] });
      }
    });
    child.on('error', () => resolve({ hits, full, failed: true }));
    child.on('close', () => resolve({ hits, full }));
  });
  return { done, cancel: () => child.kill() };
}

function registerSolutionSearch(context, findSolution, solutionView) {
  const { provider, view } = solutionView;
  const config = () => vscode.workspace.getConfiguration('csharpShooter.solutionSearch');
  let index; // Promise of { entries, projects }, dropped when files come and go
  let query = '';
  let gen = 0;
  let running; // the ripgrep of the search in progress
  let webview;
  let boxShown = false; // the box drew itself (for the tests)
  const status = (text) => webview?.postMessage({ type: 'status', text });

  // Looking for the solution takes a search of the workspace: done once per index, not per keystroke.
  const getIndex = () => {
    index = index || findSolution().then(async (file) => (file ? { file, ...(await buildIndex(file)) } : { entries: [], projects: [] }));
    return index;
  };

  /** Searches, then shows the tree filtered to the result; resolves with what it found (for the tests). */
  const search = async (text, contents = config().get('fileContents')) => {
    query = text.trim();
    const my = ++gen;
    running?.cancel();
    running = undefined;
    if (!query) {
      view.message = undefined;
      status('');
      provider.setFilter(null);
      return { names: 0, lines: 0 };
    }
    const { entries, projects, file } = await getIndex();
    if (my !== gen) return undefined;
    const match = matcher(query);
    const hits = new Map();
    const keep = new Set();
    const projectOf = new Map();
    // A hit keeps its folders up to its project, and the project.
    const add = (file, project, extra) => {
      const key = file.toLowerCase();
      const hit = hits.get(key) || { ranges: [], lines: [] };
      if (extra.ranges) hit.ranges = extra.ranges;
      if (extra.line) hit.lines.push(extra.line);
      hits.set(key, hit);
      const top = path.dirname(project).toLowerCase();
      keep.add(project.toLowerCase());
      for (let d = path.dirname(key); d.length > top.length && d.startsWith(top); d = path.dirname(d)) keep.add(d);
    };
    let tooMany = false;
    let names = 0;
    for (const e of entries) {
      projectOf.set(e.path.toLowerCase(), e.project);
      const ranges = match(e.name);
      if (!ranges) continue;
      if (++names > MAX_NAME_HITS) {
        tooMany = true;
        break;
      }
      add(e.path, e.project, { ranges });
    }
    let lines = 0;
    let note;
    if (contents && !tooMany) {
      provider.setFilter({ gen: my, hits: new Map(hits), keep: new Set(keep) }); // the names now, the contents when ripgrep is done
      status(T.searchingContents);
      const rg = ripgrepPath();
      const solutionDir = path.dirname(file);
      if (!rg) note = T.noRipgrep;
      else {
        const dirs = [...new Set(projects.map((p) => path.relative(solutionDir, path.dirname(p)) || '.'))];
        running = grep(rg, query, dirs, solutionDir, MAX_LINE_HITS);
        const result = await running.done;
        if (my !== gen) return undefined;
        tooMany = result.full;
        const folded = /\p{Lu}/u.test(query) ? (s) => s : (s) => s.toLowerCase();
        for (const h of result.hits) {
          const project = projectOf.get(h.file.toLowerCase());
          if (!project) continue; // a file the tree does not show
          const at = Math.max(0, folded(h.text).indexOf(folded(query)));
          // Leading whitespace off, as VS Code's search shows a line.
          const indent = h.text.length - h.text.trimStart().length;
          add(h.file, project, { line: { line: h.line, text: h.text.trim(), range: [at - indent, at - indent + query.length] } });
          lines++;
        }
      }
    }
    view.message = tooMany ? T.tooMany : hits.size ? note : [T.noResults, note].filter(Boolean).join(' ');
    status(hits.size ? `${T.found}: ${hits.size}${lines ? ` · ${T.lines}: ${lines}` : ''}` : '');
    provider.setFilter({ gen: my, hits, keep });
    return { names: Math.min(names, MAX_NAME_HITS), lines, tooMany, files: [...hits.keys()] };
  };

  // Files that come and go change the index, and a search showing runs again; a project or the solution changed, the
  // index is built anew.
  let timer;
  const changed = async (update) => {
    if (index) await update(await index);
    clearTimeout(timer);
    if (query) timer = setTimeout(() => search(query), 300);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const relevant = (uri) => !/[\\/](bin|obj|node_modules|\.git|\.vs)[\\/]/i.test(uri.fsPath);
  watcher.onDidCreate((u) => relevant(u) && changed((i) => i.add?.(u.fsPath)));
  watcher.onDidDelete((u) => relevant(u) && changed((i) => i.remove?.(u.fsPath)));
  watcher.onDidChange((u) => /\.(csproj|sln|slnx)$/i.test(u.fsPath) && changed(() => (index = undefined)));
  context.subscriptions.push(watcher);

  // Enter or Down in the box goes to the first result, as in VS.
  const firstResult = async () => {
    const walk = async (item) => {
      for (const c of await provider.getChildren(item)) {
        if (c.kind === 'line' || ((c.kind === 'file' || c.kind === 'folder' || c.kind === 'project') && provider.filter?.hits.get((c.resourceUri?.fsPath || c.file).toLowerCase())?.ranges.length)) return c;
        const below = c.collapsibleState === vscode.TreeItemCollapsibleState.Expanded ? await walk(c) : undefined;
        if (below) return below;
      }
      return undefined;
    };
    const first = await walk();
    if (first) await view.reveal(first, { select: true, focus: true });
  };

  const html = (contents) => {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 4px 8px 4px 20px; margin: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  .box { display: flex; align-items: center; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .box:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input { flex: 1; min-width: 0; border: 0; outline: 0; padding: 3px 4px; background: transparent; color: var(--vscode-input-foreground); font: inherit; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  button { border: 0; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; padding: 0 5px; height: 22px; font: inherit; }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  #clear { visibility: hidden; }
  .options { display: none; padding: 4px 0 0; }
  .options.open { display: block; }
  .status { padding: 4px 0 0; color: var(--vscode-descriptionForeground); }
  label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
</style></head><body>
<div class="box">
  <input id="q" placeholder="${esc(T.placeholder)}" aria-label="${esc(T.placeholder)}" spellcheck="false">
  <button id="clear" title="Wyczyść" aria-label="Wyczyść">✕</button>
  <button id="more" title="Opcje wyszukiwania" aria-label="Opcje wyszukiwania" aria-expanded="false">▾</button>
</div>
<div class="status" id="status" aria-live="polite"></div>
<div class="options" id="options">
  <label title="${esc(T.fileContentsTip)}"><input type="checkbox" id="contents"${contents ? ' checked' : ''}>${esc(T.fileContents)}</label>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const clear = document.getElementById('clear');
  const contents = document.getElementById('contents');
  let timer;
  const send = () => { clear.style.visibility = q.value ? 'visible' : 'hidden'; vscode.postMessage({ type: 'query', text: q.value }); };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(send, 120); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); clearTimeout(timer); send(); vscode.postMessage({ type: 'first' }); }
    if (e.key === 'Escape') { q.value = ''; send(); }
  });
  clear.onclick = () => { q.value = ''; send(); q.focus(); };
  document.getElementById('more').onclick = (e) => {
    const open = document.getElementById('options').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', open);
  };
  contents.onchange = () => vscode.postMessage({ type: 'contents', value: contents.checked });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'focus') { q.focus(); q.select(); }
    if (m.type === 'status') document.getElementById('status').textContent = m.text;
    if (m.type === 'set') { q.value = m.text; clear.style.visibility = q.value ? 'visible' : 'hidden'; }
  });
  q.focus();
  vscode.postMessage({ type: 'ready', box: !!q && getComputedStyle(q).display !== 'none' });
</script></body></html>`;
  };

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('csharpShooter.search', {
    resolveWebviewView(webviewView) {
      webview = webviewView.webview;
      webview.options = { enableScripts: true };
      webview.html = html(config().get('fileContents'));
      webview.onDidReceiveMessage(async (m) => {
        if (m.type === 'ready') {
          boxShown = m.box;
          if (query) webview.postMessage({ type: 'set', text: query }); // a search made before the box was there
        }
        if (m.type === 'query') await search(m.text);
        if (m.type === 'first') await firstResult();
        if (m.type === 'contents') {
          await config().update('fileContents', m.value, vscode.ConfigurationTarget.Global);
          if (query) await search(query, m.value);
        }
      });
      webviewView.onDidDispose(() => (webview = undefined));
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.solution.search', async (text) => {
    await vscode.commands.executeCommand('csharpShooter.search.focus');
    if (typeof text === 'string') {
      webview?.postMessage({ type: 'set', text });
      return search(text);
    }
    webview?.postMessage({ type: 'focus' });
    return undefined;
  }));

  return { search, matcher, firstResult, boxShown: () => boxShown };
}

module.exports = { registerSolutionSearch, matcher, terms };
