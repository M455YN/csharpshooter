// Full-screen search, Visual Studio 2026's "Szukaj wszędzie" (Ctrl+T) and Find in Files (Ctrl+Shift+F) in one editor tab,
// laid out as swiftfind's: the filters of VS's code search (Kod, Pliki f:, Typy t:, Elementy członkowskie m:) with Tekst
// (Find in Files, through ripgrep) and Funkcje (VS's Feature Search: commands and settings); VS's options and scope; the
// results grouped, a preview beside or below them, and Find in Files' summary under them.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { matcher, grep, ripgrepPath } = require('./solution-search');

const K = vscode.SymbolKind;
const TYPE_KINDS = new Set([K.Class, K.Interface, K.Enum, K.Struct]);
const MEMBER_KINDS = new Set([K.Method, K.Property, K.Field, K.Constructor, K.Function, K.Constant, K.EnumMember, K.Event, K.Operator]);
const KIND_NAMES = { [K.Class]: 'klasa', [K.Interface]: 'interfejs', [K.Enum]: 'wyliczenie', [K.Struct]: 'struktura', [K.Method]: 'metoda',
  [K.Property]: 'właściwość', [K.Field]: 'pole', [K.Constructor]: 'konstruktor', [K.Function]: 'funkcja', [K.Constant]: 'stała',
  [K.EnumMember]: 'element wyliczenia', [K.Event]: 'zdarzenie', [K.Operator]: 'operator' };
const MAX_ITEMS = 500;
const MAX_LINES = 5000;
// VS's texts (Microsoft.VisualStudio.Shell.UI.Internal, Packages.Search.Strings, and msenvui's Find in Files), in Polish.
const T = {
  title: 'Wyszukaj',
  watermark: 'Wyszukaj',
  code: 'Kod', files: 'Pliki', types: 'Typy', members: 'Elementy członkowskie', text: 'Tekst', features: 'Funkcje',
  codeTip: 'Wyszukuje pliki, typy i elementy członkowskie.',
  filesTip: 'Filtruj, aby uzyskać tylko pliki.',
  typesTip: 'Filtruj, aby uzyskać tylko typy, klasy, interfejsy i wyliczenia.',
  membersTip: 'Filtruj, aby uzyskać tylko składowe klasy i typu.',
  textTip: 'Znajdź w plikach: wiersze plików, które zawierają tekst.',
  featuresTip: 'Wyszukaj polecenia i ustawienia.',
  matchCase: 'Uwzględnij wielkość liter', wholeWord: 'Dopasuj całe wyrazy', regex: 'Użyj wyrażeń regularnych',
  scope: 'Szukaj w:', solution: 'Całe rozwiązanie', project: 'Bieżący projekt', document: 'Bieżący dokument', open: 'Wszystkie otwarte dokumenty',
  fileTypes: 'Typy plików:',
  previewRight: 'Przełącz podgląd pionowy', previewBottom: 'Przełącz podgląd poziomy', hidePreview: 'Ukryj podgląd', showPreview: 'Pokaż podgląd',
  noPreview: 'W tej chwili nie ma elementów do wyświetlenia w podglądzie.', noCodePreview: 'Ten plik nie ma podglądu.',
  seeMore: 'Pokaż więcej', seeLess: 'Pokaż mniej', recent: 'Ostatnie zapytania',
  noResults: 'Nie znaleziono wyników', noResultsYet: 'Nie ma jeszcze wyników', incomplete: 'Niekompletne wyniki',
  noResultsWithFilter: 'Zakres lub filtry ograniczają dostępne wyniki. Spróbuj je zresetować, aby zobaczyć wyniki.',
  summary: (lines, files, searched) => `Pasujące wiersze: ${lines}    Pasujące pliki: ${files}    Łączna liczba przeszukanych plików: ${searched}`,
  noProject: 'Brak bieżącego projektu: otwórz plik projektu albo zmień zakres.',
  noDocument: 'Brak bieżącego dokumentu.',
  noRipgrep: 'Nie znaleziono ripgrep (rg) edytora.',
  settings: (q) => `Ustawienia: „${q}”`, palette: (q) => `Paleta poleceń: „${q}”`,
};

/** "f:", "t:", "m:" at the start pick a filter, as in VS. */
function parseQuery(raw, filter) {
  const m = /^\s*([ftm]):\s*/.exec(raw);
  return m ? { query: raw.slice(m[0].length).trim(), filter: { f: 'files', t: 'types', m: 'members' }[m[1]] } : { query: raw.trim(), filter };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a name or a line matches, as the options say: VS's name rules (words, case only with a capital, HC) with none
 *  set; else the query as a regular expression or literal, whole words, case as asked. Throws on a bad expression. */
function nameTester(query, o) {
  if (!o.regex && !o.wholeWord && !o.matchCase) return matcher(query);
  const re = new RegExp(o.regex ? query : o.wholeWord ? `\\b${escapeRe(query)}\\b` : escapeRe(query), o.matchCase ? 'g' : 'gi');
  return (name) => {
    re.lastIndex = 0;
    const m = re.exec(name);
    return m ? [[m.index, m.index + Math.max(1, m[0].length)]] : null;
  };
}

/** Every match of a line, for its highlight (ripgrep found the line; this finds where in it). */
function lineRanges(text, query, o) {
  let re;
  try {
    re = new RegExp(o.regex ? query : o.wholeWord ? `\\b${escapeRe(query)}\\b` : escapeRe(query), o.matchCase || (o.matchCase === undefined && /\p{Lu}/u.test(query)) ? 'g' : 'gi');
  } catch {
    return [];
  }
  const out = [];
  for (let m; (m = re.exec(text)) && out.length < 20;) {
    out.push([m.index, m.index + m[0].length]);
    if (!m[0].length) re.lastIndex++;
  }
  return out;
}

function registerSearchEverywhere(context, solutionView) {
  const { getIndex } = solutionView.search;
  let panel;
  let seq = 0;
  let running;
  let lastEditor = vscode.window.activeTextEditor; // the editor before the panel took the focus: "Bieżący dokument/projekt"
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => e && e.document.uri.scheme === 'file' && (lastEditor = e)));
  const state = { ready: false, last: undefined }; // for the tests

  const relative = (file, root) => path.relative(root, file) || path.basename(file);

  /** The files a scope takes in: a predicate, and the paths ripgrep gets (relative to the solution's folder). */
  const scopeOf = async (scope, idx) => {
    const root = path.dirname(idx.file || '.');
    const under = (dir) => (p) => p.toLowerCase() === dir.toLowerCase() || p.toLowerCase().startsWith(dir.toLowerCase() + path.sep);
    const current = lastEditor?.document.uri.fsPath;
    if (scope === 'document') {
      if (!current) return { error: T.noDocument };
      return { test: (p) => p.toLowerCase() === current.toLowerCase(), paths: [relative(current, root)], root };
    }
    if (scope === 'open') {
      const files = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input?.uri).filter((u) => u?.scheme === 'file').map((u) => u.fsPath);
      const set = new Set(files.map((f) => f.toLowerCase()));
      return { test: (p) => set.has(p.toLowerCase()), paths: files.map((f) => relative(f, root)), root };
    }
    if (scope === 'project') {
      const project = current && idx.projects.filter((p) => under(path.dirname(p))(current)).sort((a, b) => b.length - a.length)[0];
      if (!project) return { error: T.noProject };
      return { test: under(path.dirname(project)), paths: [relative(path.dirname(project), root)], root, project };
    }
    const dirs = idx.projects.map((p) => path.dirname(p));
    return { test: (p) => dirs.some((d) => under(d)(p)), paths: [...new Set(dirs.map((d) => relative(d, root) || '.'))], root };
  };

  // Typy plików: "*.cs; *.cshtml" as ripgrep's globs, and as a test of a name.
  const fileTypes = (text) => (text || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const typeTest = (patterns) => {
    if (!patterns.length) return () => true;
    const res = patterns.map((g) => new RegExp(`^${g.split('*').map(escapeRe).join('.*').replace(/\\\?/g, '.')}$`, 'i'));
    return (name) => res.some((r) => r.test(name));
  };

  const searchFiles = async (query, o, scope, idx, test) => {
    const types = typeTest(fileTypes(o.fileTypes));
    const items = [];
    for (const e of idx.entries) {
      if (e.path === e.project || !types(e.name) || !scope.test(e.path)) continue;
      const ranges = test(e.name);
      if (!ranges) continue;
      try {
        if (fs.statSync(e.path).isDirectory()) continue; // the index has folders too; this filter is files
      } catch {
        continue;
      }
      items.push({ kind: 'file', label: e.name, ranges, detail: relative(path.dirname(e.path), scope.root), path: e.path, line: 0 });
      if (items.length >= MAX_ITEMS) break;
    }
    return { items, full: items.length >= MAX_ITEMS };
  };

  const searchSymbols = async (query, o, scope, kinds, test) => {
    const ask = o.regex ? query.replace(/[^\p{L}\p{N}_]/gu, '') : query;
    if (!ask) return { items: [] };
    const symbols = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', ask)) || [];
    const items = [];
    for (const s of symbols) {
      const file = s.location?.uri?.fsPath;
      if (!kinds.has(s.kind) || !file || !scope.test(file) || /[\\/](obj|bin)[\\/]/i.test(file)) continue;
      const name = s.name.replace(/\(.*$/, '');
      const ranges = test(name);
      if (!ranges) continue;
      const r = s.location.range;
      items.push({ kind: 'symbol', label: s.name, ranges, detail: `${KIND_NAMES[s.kind] || ''}${s.containerName ? ` · ${s.containerName}` : ''} · ${relative(file, scope.root)}`,
        path: file, line: r.start.line + 1, col: r.start.character });
      if (items.length >= MAX_ITEMS) break;
    }
    return { items, full: items.length >= MAX_ITEMS };
  };

  const searchFeatures = (query, test) => {
    const items = [];
    const seen = new Set();
    for (const ext of vscode.extensions.all) {
      for (const c of ext.packageJSON?.contributes?.commands || []) {
        const title = typeof c.title === 'string' && !c.title.startsWith('%') ? c.title : '';
        const category = typeof c.category === 'string' && !c.category.startsWith('%') ? c.category : '';
        const label = category ? `${category}: ${title}` : title;
        if (!title || seen.has(c.command)) continue;
        const ranges = test(label);
        if (!ranges) continue;
        seen.add(c.command);
        items.push({ kind: 'command', label, ranges, detail: ext.packageJSON.displayName || ext.id, command: c.command });
      }
    }
    // VS's Feature Search also finds options; VS Code's own commands are in its palette, which an extension cannot list.
    items.push({ kind: 'command', label: T.settings(query), ranges: [], detail: 'Ustawienia', command: 'workbench.action.openSettings', args: [query] });
    items.push({ kind: 'command', label: T.palette(query), ranges: [], detail: 'Paleta poleceń', command: 'workbench.action.quickOpen', args: [`>${query}`] });
    return { items: items.slice(0, MAX_ITEMS) };
  };

  /** One search: posts its groups as they come (text line by line, in batches) and resolves with what it found. */
  const search = async (raw, options = {}, post = () => {}) => {
    const my = ++seq;
    running?.cancel();
    running = undefined;
    const o = { filter: 'code', scope: 'solution', ...options };
    const { query, filter } = parseQuery(raw, o.filter);
    const result = { seq: my, query, filter, groups: {}, summary: '', incomplete: false, message: '' };
    const finish = () => {
      state.last = result;
      post({ type: 'done', seq: my, summary: result.summary, incomplete: result.incomplete, message: result.message, filter });
      return result;
    };
    post({ type: 'begin', seq: my, filter });
    if (!query) return finish();
    let test;
    try {
      test = nameTester(query, o);
    } catch (e) {
      result.message = e.message;
      return finish();
    }
    const idx = await getIndex();
    const scope = await scopeOf(o.scope, idx);
    if (my !== seq) return undefined;
    if (scope.error) {
      result.message = scope.error;
      return finish();
    }
    const add = (group, found) => {
      if (my !== seq) return;
      result.groups[group] = found.items;
      result.incomplete ||= !!found.full;
      post({ type: 'items', seq: my, group, items: found.items });
    };
    if (filter === 'features') add('features', searchFeatures(query, test));
    if (filter === 'code' || filter === 'files') add('files', await searchFiles(query, o, scope, idx, test));
    if (filter === 'code' || filter === 'types') add('types', await searchSymbols(query, o, scope, TYPE_KINDS, test));
    if (filter === 'code' || filter === 'members') add('members', await searchSymbols(query, o, scope, MEMBER_KINDS, test));
    if (filter === 'text') {
      const rg = ripgrepPath();
      if (!rg) {
        result.message = T.noRipgrep;
        return finish();
      }
      const lines = [];
      let batch = [];
      const flush = () => {
        if (batch.length && my === seq) post({ type: 'items', seq: my, group: 'text', items: batch, append: true });
        batch = [];
      };
      const timer = setInterval(flush, 120);
      running = grep(rg, query, scope.paths, scope.root, MAX_LINES, {
        regex: o.regex, matchCase: !!o.matchCase, wholeWord: o.wholeWord, globs: fileTypes(o.fileTypes),
        onHit: (h) => {
          const ranges = lineRanges(h.text, query, o);
          // The line from a little before its first match, so a long one still shows it.
          const indent = h.text.length - h.text.trimStart().length;
          const cut = ranges[0]?.[0] - indent > 24 ? ranges[0][0] - 16 : indent;
          const item = { kind: 'line', label: (cut > indent ? '…' : '') + h.text.slice(cut).trimEnd(), path: h.file, line: h.line,
            col: ranges[0]?.[0] ?? 0, detail: relative(h.file, scope.root) };
          const shift = item.label.startsWith('…') ? cut - 1 : cut;
          item.ranges = ranges.map(([a, b]) => [a - shift, b - shift]).filter(([a]) => a >= 0);
          item.lineRanges = ranges;
          lines.push(item);
          batch.push(item);
        },
      });
      const found = await running.done;
      clearInterval(timer);
      if (my !== seq) return undefined;
      flush();
      if (found.error) result.message = found.error;
      result.groups.text = lines;
      result.incomplete = found.full;
      const files = new Set(lines.map((l) => l.path.toLowerCase())).size;
      result.summary = T.summary(lines.length, files, found.searched ?? '?');
    } else {
      const names = { files: T.files, types: T.types, members: T.members, features: T.features };
      result.summary = Object.entries(result.groups).map(([g, items]) => `${names[g]}: ${items.length}`).join('    ');
    }
    const total = Object.values(result.groups).reduce((n, items) => n + items.length, 0);
    if (!total && !result.message) result.message = o.scope !== 'solution' || fileTypes(o.fileTypes).length ? T.noResultsWithFilter : T.noResults;
    if (total) remember(raw);
    return finish();
  };

  const recent = () => context.globalState.get('csharpShooter.searchEverywhere.recent', []);
  const remember = (q) => context.globalState.update('csharpShooter.searchEverywhere.recent', [q, ...recent().filter((x) => x !== q)].slice(0, 10));

  /** The lines around one, for the preview. */
  const preview = (file, line) => {
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) return { message: T.noCodePreview };
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\0')) return { message: T.noCodePreview };
      const all = text.split(/\r?\n/);
      const start = Math.max(1, (line || 1) - 30);
      return { start, lines: all.slice(start - 1, start - 1 + 200).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)) };
    } catch {
      return { message: T.noCodePreview };
    }
  };

  const open = async (item) => {
    if (item.kind === 'command') {
      panel?.dispose();
      return vscode.commands.executeCommand(item.command, ...(item.args || []));
    }
    const uri = vscode.Uri.file(item.path);
    if (!item.line) return vscode.window.showTextDocument(uri, { preview: true });
    const at = new vscode.Position(item.line - 1, item.col || 0);
    const length = item.kind === 'line' && item.ranges[0] ? item.ranges[0][1] - item.ranges[0][0] : 0;
    return vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(at, at.translate(0, length)) });
  };

  const show = (filter, text) => {
    const settings = context.globalState.get('csharpShooter.searchEverywhere.options', {});
    if (!panel) {
      panel = vscode.window.createWebviewPanel('csharpShooter.searchEverywhere', T.title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      panel.iconPath = new vscode.ThemeIcon('search');
      panel.webview.html = html();
      panel.onDidDispose(() => {
        panel = undefined;
        state.ready = false;
        running?.cancel();
      });
      panel.webview.onDidReceiveMessage(async (m) => {
        const post = (msg) => panel?.webview.postMessage(msg);
        if (m.type === 'ready') {
          state.ready = true;
          post({ type: 'init', options: settings, recent: recent(), filter: panel.pending?.filter, text: panel.pending?.text });
        }
        if (m.type === 'search') {
          context.globalState.update('csharpShooter.searchEverywhere.options', m.options);
          await search(m.query, m.options, post);
          post({ type: 'recent', recent: recent() });
        }
        if (m.type === 'preview') post({ type: 'preview', key: m.key, path: m.path, line: m.line, ranges: m.ranges, rel: m.rel, ...preview(m.path, m.line) });
        if (m.type === 'open') await open(m.item);
        if (m.type === 'close') panel?.dispose();
        if (m.type === 'layout') context.globalState.update('csharpShooter.searchEverywhere.layout', m.layout);
      });
    } else {
      panel.reveal(vscode.ViewColumn.Active);
    }
    panel.pending = { filter, text };
    if (state.ready) panel.webview.postMessage({ type: 'focus', filter, text });
    return panel;
  };

  // Ctrl+Shift+F starts with the selected text, as Find in Files does.
  const selection = () => {
    const e = vscode.window.activeTextEditor;
    const text = e && !e.selection.isEmpty ? e.document.getText(e.selection) : '';
    return text.includes('\n') ? '' : text;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('csharpShooter.searchEverywhere', (text) => show(undefined, typeof text === 'string' ? text : undefined)),
    vscode.commands.registerCommand('csharpShooter.findInFiles', (text) => show('text', typeof text === 'string' ? text : selection() || undefined)),
  );

  function html() {
    const nonce = String(Math.random()).slice(2);
    const layout = context.globalState.get('csharpShooter.searchEverywhere.layout', 'right');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const filters = [['code', T.code, T.codeTip], ['files', `${T.files} (f:)`, T.filesTip], ['types', `${T.types} (t:)`, T.typesTip],
      ['members', `${T.members} (m:)`, T.membersTip], ['text', T.text, T.textTip], ['features', T.features, T.featuresTip]];
    return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { padding: 12px 16px 8px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .box { flex: 1; display: flex; align-items: center; min-width: 240px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .box:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #q { flex: 1; min-width: 0; border: 0; outline: 0; padding: 6px 8px; font: inherit; font-size: 1.15em; background: transparent; color: var(--vscode-input-foreground); }
  #q::placeholder { color: var(--vscode-input-placeholderForeground); }
  .toggle { border: 1px solid transparent; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; border-radius: 3px; padding: 2px 6px; margin-right: 2px; font: inherit; min-width: 26px; }
  .toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
  .toggle[aria-pressed="true"] { background: var(--vscode-inputOption-activeBackground); border-color: var(--vscode-inputOption-activeBorder); color: var(--vscode-inputOption-activeForeground); }
  .filters { display: flex; gap: 4px; flex-wrap: wrap; }
  .filter { border: 1px solid var(--line); background: transparent; color: var(--vscode-foreground); padding: 3px 10px; border-radius: 12px; cursor: pointer; font: inherit; }
  .filter:hover { background: var(--vscode-list-hoverBackground); }
  .filter[aria-selected="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  label { color: var(--muted); display: flex; gap: 6px; align-items: center; }
  select, input.types { font: inherit; padding: 3px 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); }
  input.types { width: 160px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .spacer { flex: 1; }
  .icon { border: 0; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; padding: 3px 7px; border-radius: 3px; font: inherit; }
  .icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  main { flex: 1; min-height: 0; display: flex; }
  main.bottom { flex-direction: column; }
  #results { flex: 1.4; min-width: 0; min-height: 0; overflow: auto; padding: 4px 0; }
  #preview { flex: 1; min-width: 0; min-height: 0; overflow: auto; border-left: 1px solid var(--line); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  main.bottom #preview { border-left: 0; border-top: 1px solid var(--line); }
  main.hidden #preview { display: none; }
  .group { padding: 8px 16px 2px; color: var(--muted); font-size: .85em; text-transform: uppercase; letter-spacing: .04em; display: flex; gap: 8px; }
  .file { padding: 6px 16px 2px; font-weight: 600; display: flex; gap: 8px; cursor: pointer; }
  .file .count { color: var(--muted); font-weight: 400; }
  .item { padding: 2px 16px 2px 28px; display: flex; gap: 10px; align-items: baseline; cursor: pointer; white-space: nowrap; }
  .item.top { padding-left: 16px; }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .item .label { overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; max-width: 70%; }
  .line .label { flex-shrink: 1; max-width: none; }
  .item .detail, .item .ln { color: var(--muted); overflow: hidden; text-overflow: ellipsis; font-size: .9em; }
  .item.sel .detail, .item.sel .ln { color: inherit; opacity: .85; }
  .item .ln { min-width: 3em; text-align: right; font-family: var(--vscode-editor-font-family); }
  .line .label { font-family: var(--vscode-editor-font-family); }
  mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; border-radius: 2px; }
  .more { padding: 2px 16px 6px; }
  .more button { border: 0; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; padding: 0; }
  .recent { padding: 8px 16px; }
  .recent .item { padding-left: 16px; }
  .message { padding: 24px 16px; color: var(--muted); }
  .phead { position: sticky; top: 0; padding: 6px 12px; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); color: var(--muted); font-family: var(--vscode-font-family); border-bottom: 1px solid var(--line); }
  .code { margin: 0; padding: 4px 0; }
  .code div { display: flex; white-space: pre; }
  .code .n { min-width: 4.5em; padding-right: 12px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
  .code .hit { background: var(--vscode-editor-lineHighlightBackground, #8882); }
  .code .hit .n { color: var(--vscode-editorLineNumber-activeForeground); }
  footer { padding: 6px 16px; border-top: 1px solid var(--line); color: var(--muted); display: flex; gap: 16px; min-height: 30px; align-items: center; white-space: pre; }
  footer .warn { color: var(--vscode-editorWarning-foreground); }
  progress { height: 2px; width: 100%; position: absolute; top: 0; left: 0; border: 0; appearance: none; background: transparent; }
  progress::-webkit-progress-bar { background: transparent; }
  progress:indeterminate { background: linear-gradient(90deg, transparent, var(--vscode-progressBar-background), transparent); background-size: 40% 100%; animation: slide 1.2s linear infinite; }
  @keyframes slide { from { background-position: -40% 0; } to { background-position: 140% 0; } }
</style></head><body>
<progress id="busy" hidden></progress>
<header>
  <div class="row">
    <div class="box">
      <input id="q" placeholder="${esc(T.watermark)}" aria-label="${esc(T.watermark)}" spellcheck="false" autocomplete="off">
      <button class="toggle" id="matchCase" title="${esc(T.matchCase)}" aria-pressed="false">Aa</button>
      <button class="toggle" id="wholeWord" title="${esc(T.wholeWord)}" aria-pressed="false"><u>ab</u></button>
      <button class="toggle" id="regex" title="${esc(T.regex)}" aria-pressed="false">.*</button>
    </div>
  </div>
  <div class="row">
    <div class="filters" role="tablist">${filters.map(([id, text, tip]) => `<button class="filter" role="tab" data-filter="${id}" title="${esc(tip)}" aria-selected="false">${esc(text)}</button>`).join('')}</div>
    <span class="spacer"></span>
    <label>${esc(T.scope)} <select id="scope">
      <option value="solution">${esc(T.solution)}</option><option value="project">${esc(T.project)}</option>
      <option value="document">${esc(T.document)}</option><option value="open">${esc(T.open)}</option></select></label>
    <label>${esc(T.fileTypes)} <input class="types" id="fileTypes" placeholder="*.cs;*.cshtml" spellcheck="false"></label>
    <button class="icon" id="pRight" title="${esc(T.previewRight)}" aria-label="${esc(T.previewRight)}">◫</button>
    <button class="icon" id="pBottom" title="${esc(T.previewBottom)}" aria-label="${esc(T.previewBottom)}">⬓</button>
    <button class="icon" id="pHide" title="${esc(T.hidePreview)}" aria-label="${esc(T.hidePreview)}">▢</button>
  </div>
</header>
<main id="main" class="${esc(layout)}">
  <div id="results" role="listbox" aria-label="Wyniki wyszukiwania"></div>
  <div id="preview"><div class="message">${esc(T.noPreview)}</div></div>
</main>
<footer id="footer"></footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify({ files: T.files, types: T.types, members: T.members, text: T.text, features: T.features, seeMore: T.seeMore, seeLess: T.seeLess,
    recent: T.recent, noResultsYet: T.noResultsYet, incomplete: T.incomplete, noPreview: T.noPreview, showPreview: T.showPreview, hidePreview: T.hidePreview })};
  const $ = (id) => document.getElementById(id);
  const q = $('q'), results = $('results'), previewEl = $('preview'), footer = $('footer'), main = $('main');
  let filter = 'code', seq = 0, groups = {}, expanded = {}, rows = [], sel = -1, timer, recentList = [], lastPreviewKey = '';
  const options = () => ({ filter, matchCase: $('matchCase').getAttribute('aria-pressed') === 'true', wholeWord: $('wholeWord').getAttribute('aria-pressed') === 'true',
    regex: $('regex').getAttribute('aria-pressed') === 'true', scope: $('scope').value, fileTypes: $('fileTypes').value });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const marked = (text, ranges) => {
    let out = '', at = 0;
    for (const [a, b] of [...(ranges || [])].sort((x, y) => x[0] - y[0])) {
      if (a < at) continue;
      out += esc(text.slice(at, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
      at = b;
    }
    return out + esc(text.slice(at));
  };
  const setFilter = (f) => {
    filter = f;
    document.querySelectorAll('.filter').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.filter === f)));
  };
  const run = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'search', query: q.value, options: options() }), delay);
  };
  q.addEventListener('input', () => {
    // f:, t:, m: switch the filter, as in VS.
    const m = /^\\s*([ftm]):/.exec(q.value);
    if (m) setFilter({ f: 'files', t: 'types', m: 'members' }[m[1]]);
    run(filter === 'text' ? 250 : 120);
  });
  document.querySelectorAll('.filter').forEach((b) => b.onclick = () => { setFilter(b.dataset.filter); q.value = q.value.replace(/^\\s*[ftm]:\\s*/, ''); run(0); q.focus(); });
  ['matchCase', 'wholeWord', 'regex'].forEach((id) => $(id).onclick = () => { const b = $(id); b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); run(0); q.focus(); });
  $('scope').onchange = () => run(0);
  $('fileTypes').addEventListener('input', () => run(300));
  const setLayout = (l) => { main.className = l; vscode.postMessage({ type: 'layout', layout: l }); $('pHide').title = l === 'hidden' ? T.showPreview : T.hidePreview; if (l !== 'hidden') showPreview(); };
  $('pRight').onclick = () => setLayout('right');
  $('pBottom').onclick = () => setLayout('bottom');
  $('pHide').onclick = () => setLayout(main.className === 'hidden' ? 'right' : 'hidden');

  const names = { files: T.files, types: T.types, members: T.members, text: T.text, features: T.features };
  const render = () => {
    rows = [];
    let html = '';
    const keys = Object.keys(groups).filter((g) => groups[g].length);
    const many = keys.length > 1;
    for (const g of keys) {
      const items = groups[g];
      if (g === 'text') {
        // Find in Files: grouped by file, its lines under it.
        const byFile = new Map();
        for (const it of items) (byFile.get(it.path) || byFile.set(it.path, []).get(it.path)).push(it);
        for (const [file, list] of byFile) {
          html += '<div class="file" data-row="' + rows.length + '"><span>' + esc(list[0].detail) + '</span><span class="count">' + list.length + '</span></div>';
          rows.push({ kind: 'file', header: true, label: list[0].detail, path: file, line: 0, ranges: [] });
          for (const it of list) {
            html += '<div class="item line" role="option" data-row="' + rows.length + '"><span class="ln">' + it.line + '</span><span class="label">' + marked(it.label, it.ranges) + '</span></div>';
            rows.push(it);
          }
        }
        continue;
      }
      const limit = many && !expanded[g] ? 8 : Infinity;
      if (many) html += '<div class="group">' + esc(names[g]) + ' <span>' + items.length + '</span></div>';
      for (const it of items.slice(0, limit)) {
        html += '<div class="item top" role="option" data-row="' + rows.length + '"><span class="label">' + marked(it.label, it.ranges) + '</span><span class="detail">' + esc(it.detail || '') + '</span></div>';
        rows.push(it);
      }
      if (many && items.length > 8) html += '<div class="more"><button data-more="' + g + '">' + (expanded[g] ? T.seeLess : T.seeMore) + '</button></div>';
    }
    if (!html && !q.value.trim() && recentList.length) {
      html = '<div class="group">' + esc(T.recent) + '</div>' + recentList.map((r) => '<div class="item top recent-q" data-q="' + esc(r) + '"><span class="label">' + esc(r) + '</span></div>').join('');
    }
    results.innerHTML = html || '<div class="message">' + esc(T.noResultsYet) + '</div>';
    if (sel >= rows.length) sel = rows.length - 1;
    if (sel < 0 && rows.length) sel = rows.findIndex((r) => !r.header);
    mark();
  };
  const mark = () => {
    results.querySelectorAll('.sel').forEach((e) => e.classList.remove('sel'));
    const el = results.querySelector('[data-row="' + sel + '"]');
    if (el) { el.classList.add('sel'); el.scrollIntoView({ block: 'nearest' }); }
    showPreview();
  };
  const showPreview = () => {
    const r = rows[sel];
    if (main.className === 'hidden') return;
    if (!r || !r.path) { previewEl.innerHTML = '<div class="message">' + esc(T.noPreview) + '</div>'; lastPreviewKey = ''; return; }
    const key = r.path + ':' + r.line;
    if (key === lastPreviewKey) return;
    lastPreviewKey = key;
    vscode.postMessage({ type: 'preview', key, path: r.path, line: r.line, ranges: r.kind === 'line' ? r.lineRanges : [], rel: r.detail });
  };
  results.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { expanded[more.dataset.more] = !expanded[more.dataset.more]; render(); return; }
    const rq = e.target.closest('.recent-q');
    if (rq) { q.value = rq.dataset.q; run(0); q.focus(); return; }
    const row = e.target.closest('[data-row]');
    if (!row) return;
    sel = Number(row.dataset.row);
    mark();
  });
  results.addEventListener('dblclick', (e) => { const row = e.target.closest('[data-row]'); if (row) vscode.postMessage({ type: 'open', item: rows[Number(row.dataset.row)] }); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      mark();
    } else if (e.key === 'Enter' && rows[sel] && (document.activeElement === q || document.activeElement === document.body)) {
      e.preventDefault();
      vscode.postMessage({ type: 'open', item: rows[sel] });
    } else if (e.key === 'Escape') {
      vscode.postMessage({ type: 'close' });
    }
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init' || m.type === 'focus') {
      if (m.type === 'init' && m.options) {
        ['matchCase', 'wholeWord', 'regex'].forEach((id) => $(id).setAttribute('aria-pressed', String(!!m.options[id])));
        if (m.options.scope) $('scope').value = m.options.scope;
        if (m.options.fileTypes) $('fileTypes').value = m.options.fileTypes;
        if (m.options.filter) setFilter(m.options.filter);
      }
      if (m.recent) recentList = m.recent;
      if (m.filter) setFilter(m.filter);
      if (typeof m.text === 'string') { q.value = m.text; run(0); }
      if (m.type === 'init' && !m.text) render();
      q.focus(); q.select();
    }
    if (m.type === 'recent') recentList = m.recent;
    if (m.type === 'begin') {
      seq = m.seq; groups = {}; sel = -1; expanded = {}; lastPreviewKey = '';
      $('busy').hidden = false;
      footer.textContent = '';
    }
    if (m.seq !== undefined && m.seq !== seq) return;
    if (m.type === 'items') {
      groups[m.group] = m.append ? (groups[m.group] || []).concat(m.items) : m.items;
      render();
    }
    if (m.type === 'done') {
      $('busy').hidden = true;
      if (m.message) results.innerHTML = rows.length ? results.innerHTML : '<div class="message">' + esc(m.message) + '</div>';
      footer.innerHTML = '<span>' + esc(m.summary || '') + '</span>' + (m.incomplete ? '<span class="warn">' + esc(T.incomplete) + '</span>' : '') +
        (m.message && rows.length ? '<span class="warn">' + esc(m.message) + '</span>' : '');
      if (!rows.length && !q.value.trim()) render();
    }
    if (m.type === 'preview' && m.key === lastPreviewKey) {
      if (m.message) { previewEl.innerHTML = '<div class="phead">' + esc(m.rel || '') + '</div><div class="message">' + esc(m.message) + '</div>'; return; }
      previewEl.innerHTML = '<div class="phead">' + esc(m.rel || '') + (m.line ? ' : ' + m.line : '') + '</div><pre class="code">' + m.lines.map((l, i) => {
        const n = m.start + i;
        const hit = n === m.line;
        return '<div' + (hit ? ' class="hit" id="hit"' : '') + '><span class="n">' + n + '</span><span>' + (hit && m.ranges && m.ranges.length ? marked(l, m.ranges) : esc(l)) + '</span></div>';
      }).join('') + '</pre>';
      const hitEl = document.getElementById('hit');
      if (hitEl) hitEl.scrollIntoView({ block: 'center' });
    }
  });
  setFilter('code');
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  return { search, show, state, parseQuery };
}

module.exports = { registerSearchEverywhere, parseQuery };
