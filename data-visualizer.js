// Visual Studio's DataSet visualizer for a DataTable, DataSet or DataView while debugging: a magnifier beside the
// variable (Variables, Watch) opens its rows in a table, read from the stopped program through the debugger's own
// evaluation (Passenger compiles C# with Roslyn's expression compiler, as VS does): its tables, its columns, its rows a page
// at a time as the table is scrolled; filtered, sorted, copied and saved as CSV here, with VS's Polish texts.
const vscode = require('vscode');
const fs = require('fs');

const PAGE = 200;
const T = {
  title: (name) => `Wizualizator ${name}`,
  table: 'Tabela:',
  filter: 'Filtruj', clearFilter: 'Wyczyść filtr',
  copy: 'Kopiuj', copyAll: 'Kopiuj wszystko', exportCsv: 'Eksportuj do pliku CSV...', saveCsv: 'Zapisz plik CSV', csvFile: 'Plik CSV',
  currentRow: (n, total) => `Wiersz ${n} z ${total}`, totalRows: (n) => `Razem wierszy: ${n}`, selectedRows: (n) => `Zaznaczono wierszy: ${n}`,
  fetching: 'Trwa pobieranie większej ilości danych z aplikacji...', fetchingAll: 'Trwa pobieranie pozostałych danych...',
  exporting: 'Trwa eksportowanie danych...',
  unavailable: 'Wizualizatory są niedostępne, gdy program docelowy jest uruchomiony lub jeśli nie można ocenić wyrażenia.',
  empty: (name) => `<Obiekt ${name} jest pusty>`,
  deleted: 'Usunięto', ascending: 'Rosnąco', descending: 'Malejąco',
  noExpression: 'Tej zmiennej nie da się ocenić jako wyrażenia: dodaj ją do czujki (Watch) i otwórz wizualizator stamtąd.',
};
// Separators the cells are sent with: control characters a table's text does not hold.
const ROW = '\u001e';
const CELL = '\u001f';
const NULL = '\u0002';
const DELETED = '\u0003';

/** DataTable, DataSet or DataView by the type the debugger reports ("System.Data.DataTable", or without its namespace). */
const kindOf = (type) => /(?:^|\.)(DataTable|DataSet|DataView)$/.exec(String(type || '').trim())?.[1];

/** A string the debugger shows as a C# literal ("a\u001fb"), as its text. */
function unquote(value) {
  const v = String(value ?? '');
  if (!v.startsWith('"')) return v;
  return v.slice(1, v.lastIndexOf('"')).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,4}|.)/g, (_, e) => {
    if (e[0] === 'u' || (e[0] === 'x' && e.length > 1)) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v' }[e] ?? e;
  });
}

const L = 'System.Linq.Enumerable';
const cellsOf = (row) => `string.Join("\\u001f", ${L}.Select(${row}.ItemArray, v => v == null || v is System.DBNull ? "\\u0002" : v.ToString()))`;
const rowText = (row) => `(${row}.RowState == System.Data.DataRowState.Deleted ? "\\u0003" : ${cellsOf(row)})`;

/** Loads assemblies into the stopped program (Assembly.Load, run in it); one that fails to load is left. */
async function loadAssemblies(session, frameId, names) {
  for (const name of names) {
    await session.customRequest('evaluate', { expression: `System.Reflection.Assembly.Load("${name}")`, frameId, context: 'watch' }).catch(() => {});
  }
}

/** Reads one object's tables, columns and rows from the stopped program by evaluating C# in the frame. */
class Source {
  constructor(session, frameId, expression, kind) {
    Object.assign(this, { session, frameId, expression: `(${expression})`, kind });
    this.perRow = false; // a debugger that cannot run the lambdas of a page is asked row by row
  }

  async eval(expression, retried) {
    const r = await this.session.customRequest('evaluate', { expression, frameId: this.frameId, context: 'watch' });
    if (/^(error|.*Exception\b)/i.test(r.type || '') || r.presentationHint?.attributes?.includes('failedEvaluation')) {
      // An assembly the program has not loaded yet (System.Linq for the pages, System.Data.Common): loaded into it, as VS's
      // debugger loads what its expression compiler names, and asked again once.
      if (!retried && /does not exist in the namespace|missing an assembly reference/.test(r.result)) {
        await loadAssemblies(this.session, this.frameId, ['System.Linq', 'System.Data.Common']);
        return this.eval(expression, true);
      }
      throw new Error(r.result);
    }
    return r.result;
  }

  async text(expression) {
    return unquote(await this.eval(expression));
  }

  async number(expression) {
    return Number(await this.eval(expression));
  }

  /** A DataSet's tables (name, rows); one table for a DataTable or DataView. */
  async tables() {
    if (this.kind !== 'DataSet') return [{ index: 0, name: this.kind === 'DataView' ? await this.text(`${this.expression}.Table.TableName`) : await this.text(`${this.expression}.TableName`) }];
    const count = await this.number(`${this.expression}.Tables.Count`);
    const list = [];
    for (let i = 0; i < count; i++) list.push({ index: i, name: await this.text(`${this.expression}.Tables[${i}].TableName`) });
    return list;
  }

  table(index) {
    return this.kind === 'DataSet' ? `${this.expression}.Tables[${index}]` : this.kind === 'DataView' ? `${this.expression}.Table` : this.expression;
  }

  async columns(index) {
    const t = this.table(index);
    const count = await this.number(`${t}.Columns.Count`);
    const list = [];
    for (let c = 0; c < count; c++) {
      const [name, type] = (await this.text(`${t}.Columns[${c}].ColumnName + "\\u001f" + ${t}.Columns[${c}].DataType.Name`)).split(CELL);
      list.push({ name, type });
    }
    return list;
  }

  async count(index) {
    return this.number(this.kind === 'DataView' ? `${this.expression}.Count` : `${this.table(index)}.Rows.Count`);
  }

  /** Rows [start, start + n): each its cells' text (null for a null or DBNull), or { deleted: true }. */
  async rows(index, start, n) {
    const parse = (text) => (text === DELETED ? { deleted: true } : { cells: text.split(CELL).map((c) => (c === NULL ? null : c)) });
    const rowsOf = this.kind === 'DataView'
      ? `${L}.Select(${L}.Cast<System.Data.DataRowView>(${this.expression}), v => v.Row)`
      : `${L}.Cast<System.Data.DataRow>(${this.table(index)}.Rows)`;
    if (!this.perRow) {
      try {
        const text = await this.text(`string.Join("\\u001e", ${L}.Select(${L}.Take(${L}.Skip(${rowsOf}, ${start}), ${n}), r => ${rowText('r')}))`);
        return text === '' ? [] : text.split(ROW).map(parse);
      } catch {
        this.perRow = true;
      }
    }
    const out = [];
    for (let i = start; i < start + n; i++) {
      const row = this.kind === 'DataView' ? `${this.expression}[${i}].Row` : `${this.table(index)}.Rows[${i}]`;
      // Without lambdas: DBNull's text is empty, as null's.
      out.push(parse(await this.text(`(${row}.RowState == System.Data.DataRowState.Deleted ? "\\u0003" : string.Join("\\u001f", ${row}.ItemArray))`)));
    }
    return out;
  }
}

function csv(columns, rows) {
  const field = (v) => (v == null ? '' : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns.map((c) => field(c.name)).join(','), ...rows.map((r) => (r.deleted ? columns.map(() => '') : r.cells).map(field).join(','))].join('\r\n') + '\r\n';
}

function registerDataVisualizer(context) {
  const state = { panels: [] }; // for the tests: each panel's source and what its page said

  /** Opens the visualizer on a variable: { evaluateName, name, type } of the debugger's, in the active frame. */
  const open = async (variable, session = vscode.debug.activeDebugSession, frameId = vscode.debug.activeStackItem?.frameId) => {
    const kind = kindOf(variable?.type);
    if (!variable?.evaluateName) {
      vscode.window.showWarningMessage(T.noExpression);
      return undefined;
    }
    if (!session || frameId === undefined || !kind) {
      vscode.window.showWarningMessage(T.unavailable);
      return undefined;
    }
    const source = new Source(session, frameId, variable.evaluateName, kind);
    const name = variable.name || variable.evaluateName;
    const panel = vscode.window.createWebviewPanel('csharpShooter.dataVisualizer', `${T.title(kind)} — ${name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = new vscode.ThemeIcon('table');
    const entry = { source, panel, ready: false, said: {} };
    state.panels.push(entry);
    panel.onDidDispose(() => state.panels.splice(state.panels.indexOf(entry), 1));
    const post = (m) => panel.webview.postMessage(m);
    let current = { index: 0, columns: [], rows: [], count: 0 };
    let loading;

    /** Pages until `upTo` rows are there (all of them with Infinity), sent to the page as they come. */
    const fetch = async (upTo) => {
      while (current.rows.length < Math.min(upTo, current.count)) {
        const my = current;
        const page = await source.rows(my.index, my.rows.length, Math.min(PAGE, my.count - my.rows.length));
        if (my !== current) return;
        if (!page.length) break;
        my.rows.push(...page);
        post({ type: 'rows', rows: page, loaded: my.rows.length, count: my.count });
      }
    };
    const guarded = async (message, work) => {
      post({ type: 'busy', message });
      try {
        await (loading = work());
      } catch (e) {
        post({ type: 'error', message: `${T.unavailable} (${e.message})` });
      } finally {
        post({ type: 'busy', message: '' });
      }
    };
    const showTable = (index) => guarded(T.fetching, async () => {
      current = { index, columns: [], rows: [], count: 0 };
      const my = current;
      my.columns = await source.columns(index);
      my.count = await source.count(index);
      if (my !== current) return;
      post({ type: 'table', columns: my.columns, count: my.count, empty: !my.count ? T.empty(name) : '' });
      await fetch(PAGE);
    });

    // What the page asks; the tests ask it the same way (more rows, all of them).
    const request = (entry.request = async (m) => {
      if (m.type === 'ready') {
        entry.ready = true;
        let tables = [];
        await guarded(T.fetching, async () => {
          tables = await source.tables();
          post({ type: 'tables', tables, kind });
          if (!tables.length) post({ type: 'table', columns: [], count: 0, empty: T.empty(name) });
        });
        if (tables.length) await showTable(0);
      }
      if (m.type === 'select') await showTable(m.index);
      if (m.type === 'more') await guarded(T.fetching, () => fetch(current.rows.length + PAGE));
      if (m.type === 'all') await guarded(T.fetchingAll, () => fetch(Infinity)).then(() => post({ type: 'all', reason: m.reason }));
      if (m.type === 'copy') await vscode.env.clipboard.writeText(m.text);
      if (m.type === 'csv') {
        await guarded(T.fetchingAll, () => fetch(Infinity));
        const target = await vscode.window.showSaveDialog({ title: T.saveCsv, filters: { [T.csvFile]: ['csv'] },
          defaultUri: vscode.Uri.file(require('path').join(require('os').homedir(), `${name.replace(/[^\w.-]+/g, '_')}.csv`)) });
        if (target) {
          fs.writeFileSync(target.fsPath, `﻿${csv(current.columns, current.rows)}`);
          entry.said.csv = target.fsPath;
        }
      }
      if (m.type === 'state') entry.said = { ...entry.said, ...m.state };
    });
    panel.webview.onDidReceiveMessage(request);
    panel.webview.html = html();
    return entry;
  };

  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.visualizeData', (arg) => {
    // debug/variables/context and debug/watch/context give { variable: { name, evaluateName, type, ... } }.
    const variable = arg?.variable || arg;
    return open(variable);
  }));
  // A visualizer reads the stopped program: it says so once the program goes on (VS's infobar).
  context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem((item) => {
    if (item) return;
    for (const p of state.panels) p.panel.webview.postMessage({ type: 'running', message: T.unavailable });
  }));

  function html() {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  label { color: var(--muted); display: flex; gap: 6px; align-items: center; }
  [hidden] { display: none !important; }
  select, input { font: inherit; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  button { font: inherit; padding: 3px 10px; border: 0; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .spacer { flex: 1; }
  .info { padding: 6px 12px; background: var(--vscode-editorWarning-background, var(--vscode-inputValidation-warningBackground)); color: var(--vscode-editorWarning-foreground, inherit); display: none; }
  main { flex: 1; overflow: auto; min-height: 0; }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--line); padding: 2px 8px; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); cursor: pointer; user-select: none; font-family: var(--vscode-font-family); }
  th .sort { color: var(--muted); padding-left: 4px; }
  td.n, th.n { color: var(--muted); text-align: right; background: var(--vscode-editorGroupHeader-tabsBackground, transparent); cursor: default; }
  td.null { color: var(--muted); font-style: italic; }
  tr.deleted td { color: var(--muted); text-decoration: line-through; }
  tr.sel td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .message { padding: 16px; color: var(--muted); }
  footer { display: flex; gap: 16px; padding: 4px 12px; border-top: 1px solid var(--line); color: var(--muted); min-height: 26px; align-items: center; }
</style></head><body>
<header>
  <label id="tableBox" hidden>${esc(T.table)} <select id="table"></select></label>
  <label>${esc(T.filter)} <input id="filter" spellcheck="false" placeholder="${esc(T.filter)}"></label>
  <button id="clearFilter">${esc(T.clearFilter)}</button>
  <span class="spacer"></span>
  <button id="copy">${esc(T.copy)}</button>
  <button id="copyAll">${esc(T.copyAll)}</button>
  <button id="csv">${esc(T.exportCsv)}</button>
</header>
<div class="info" id="info"></div>
<main id="main"><div class="message">${esc(T.fetching)}</div></main>
<footer><span id="status"></span><span id="busy"></span></footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify({ deleted: T.deleted, ascending: T.ascending, descending: T.descending })};
  const $ = (id) => document.getElementById(id);
  let columns = [], rows = [], count = 0, sortBy = -1, sortDir = 0, filter = '', selected = new Set(), last = -1, view = [], pendingAll = null;
  const fmt = { cur: ${T.currentRow.toString()}, total: ${T.totalRows.toString()}, sel: ${T.selectedRows.toString()} };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const text = (r) => r.deleted ? columns.map(() => '') : r.cells.map((c) => c == null ? '' : c);
  const compare = (a, b) => {
    const x = a.r.cells?.[sortBy], y = b.r.cells?.[sortBy];
    if (x == null || y == null) return (x == null) - (y == null);
    const nx = Number(x), ny = Number(y);
    return x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
  };
  const compute = () => {
    const f = filter.toLowerCase();
    view = rows.map((r, i) => ({ r, i })).filter(({ r }) => !f || (!r.deleted && r.cells.some((c) => c != null && c.toLowerCase().includes(f))));
    if (sortBy >= 0 && sortDir) { view.sort(compare); if (sortDir < 0) view.reverse(); }
  };
  const render = () => {
    compute();
    if (!columns.length) { status(); return; }
    let h = '<table><thead><tr><th class="n"></th>' + columns.map((c, i) => '<th data-col="' + i + '" title="' + esc(c.type) + '">' + esc(c.name) +
      '<span class="sort">' + (sortBy === i ? (sortDir > 0 ? '▲' : '▼') : '') + '</span></th>').join('') + '</tr></thead><tbody>';
    for (const { r, i } of view) {
      h += '<tr data-row="' + i + '" class="' + (r.deleted ? 'deleted ' : '') + (selected.has(i) ? 'sel' : '') + '"><td class="n">' + (r.deleted ? esc(T.deleted) : i + 1) + '</td>' +
        (r.deleted ? columns.map(() => '<td></td>') : r.cells.map((c) => c == null ? '<td class="null">NULL</td>' : '<td title="' + esc(c) + '">' + esc(c) + '</td>')).join('') + '</tr>';
    }
    $('main').innerHTML = h + '</tbody></table>';
    status();
  };
  const status = () => {
    const n = selected.size;
    $('status').textContent = n === 1 ? fmt.cur([...selected][0] + 1, count) : n > 1 ? fmt.sel(n) : fmt.total(count);
    vscode.postMessage({ type: 'state', state: { columns: columns.map((c) => c.name), loaded: rows.length, count, shown: view.length, status: $('status').textContent,
      first: view[0] ? text(view[0].r).join('|') : '', filter, sortBy, sortDir } });
  };
  // Filter, sort and "copy all" work on every row: the rest are fetched first, as VS does.
  const needAll = (reason) => { if (rows.length < count) { pendingAll = reason; vscode.postMessage({ type: 'all', reason }); return true; } return false; };
  $('filter').addEventListener('input', () => { filter = $('filter').value; if (filter && needAll('filter')) return; render(); });
  $('clearFilter').onclick = () => { $('filter').value = filter = ''; render(); };
  $('main').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (th) {
      const c = Number(th.dataset.col);
      sortDir = sortBy === c ? (sortDir === 1 ? -1 : sortDir === -1 ? 0 : 1) : 1;
      sortBy = c;
      if (sortDir && needAll('sort')) return;
      render();
      return;
    }
    const tr = e.target.closest('tr[data-row]');
    if (!tr) return;
    const i = Number(tr.dataset.row);
    if (e.shiftKey && last >= 0) {
      const a = view.findIndex((v) => v.i === last), b = view.findIndex((v) => v.i === i);
      if (!e.ctrlKey) selected.clear();
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) selected.add(view[k].i);
    } else if (e.ctrlKey || e.metaKey) { selected.has(i) ? selected.delete(i) : selected.add(i); last = i; }
    else { selected = new Set([i]); last = i; }
    render();
  });
  const tsv = (list) => [columns.map((c) => c.name).join('\\t'), ...list.map((r) => text(r).join('\\t'))].join('\\r\\n');
  $('copy').onclick = () => vscode.postMessage({ type: 'copy', text: tsv(view.filter((v) => selected.has(v.i)).map((v) => v.r)) });
  $('copyAll').onclick = () => { if (needAll('copyAll')) return; vscode.postMessage({ type: 'copy', text: tsv(view.map((v) => v.r)) }); };
  $('csv').onclick = () => vscode.postMessage({ type: 'csv' });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected.size && document.activeElement !== $('filter')) $('copy').click(); });
  $('table').onchange = () => { selected.clear(); vscode.postMessage({ type: 'select', index: Number($('table').value) }); };
  // More rows as the table is scrolled to its end.
  $('main').addEventListener('scroll', () => {
    const m = $('main');
    if (!filter && !sortDir && rows.length < count && m.scrollTop + m.clientHeight > m.scrollHeight - 200 && !$('busy').textContent) vscode.postMessage({ type: 'more' });
  });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    // The tests type a filter and click a header as a person does.
    if (m.type === 'typeFilter') { $('filter').value = m.text; $('filter').dispatchEvent(new Event('input')); }
    if (m.type === 'clickHeader') document.querySelector('th[data-col="' + m.col + '"]')?.click();
    if (m.type === 'tables') {
      $('table').innerHTML = m.tables.map((t) => '<option value="' + t.index + '">' + esc(t.name || ('Table' + (t.index + 1))) + '</option>').join('');
      $('tableBox').hidden = m.kind !== 'DataSet';
    }
    if (m.type === 'table') {
      columns = m.columns; count = m.count; rows = []; selected.clear(); sortBy = -1; sortDir = 0;
      if (m.empty) { $('main').innerHTML = '<div class="message">' + esc(m.empty) + '</div>'; status(); }
    }
    if (m.type === 'rows') { rows = rows.concat(m.rows); count = m.count; render(); }
    if (m.type === 'all') {
      if (pendingAll === 'copyAll') vscode.postMessage({ type: 'copy', text: tsv(view.map((v) => v.r)) });
      pendingAll = null;
      render();
    }
    if (m.type === 'busy') $('busy').textContent = m.message;
    if (m.type === 'error' || m.type === 'running') { $('info').textContent = m.message; $('info').style.display = 'block'; }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  return { open, state, kindOf, unquote, csv, loadAssemblies };
}

module.exports = { registerDataVisualizer, kindOf, unquote };
