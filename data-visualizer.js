// Visual Studio's DataSet and IEnumerable visualizers for a DataTable, DataSet, DataView or a collection while debugging: a magnifier beside the
// variable (Variables, Watch) opens its rows in a table, read from the stopped program through the debugger's own
// evaluation (Passenger compiles C# with Roslyn's expression compiler, as VS does): its tables, its columns, its rows a page
// at a time as the table is scrolled; filtered, sorted, copied and saved as CSV here, with VS's Polish texts.
const vscode = require('vscode');
const { t, table } = require('./l10n');
const { registerVariablePaths } = require('./variable-paths');
const fs = require('fs');

const PAGE = 200;
const T = table({
  title: '{0} Visualizer',
  table: 'Table:',
  filter: 'Filter',
  clearFilter: 'Clear filter',
  copy: 'Copy',
  copyAll: 'Copy all',
  exportCsv: 'Export to CSV file...',
  saveCsv: 'Save CSV file',
  csvFile: 'CSV file',
  currentRow: 'Row {0} of {1}',
  totalRows: 'Total rows: {0}',
  selectedRows: 'Selected rows: {0}',
  fetching: 'Fetching more data from the application...',
  fetchingAll: 'Fetching the rest of the data...',
  exporting: 'Exporting data...',
  exportExcel: 'Export to Excel...',
  updateError: 'Row update error',
  cannotEdit: 'The cell cannot be updated because the row cannot be edited.',
  unavailable: 'Visualizers are unavailable while the target is running or if the expression cannot be evaluated.',
  empty: '<{0} object is empty>',
  deleted: 'Deleted',
  ascending: 'Ascending',
  descending: 'Descending',
  noExpression: 'This variable cannot be evaluated as an expression: add it to Watch and open the visualizer from there.',
});
// Separators the cells are sent with: control characters a table's text does not hold.
const ROW = '\u001e';
const CELL = '\u001f';
const NULL = '\u0002';
const DELETED = '\u0003';

/** DataTable, DataSet or DataView by the type the debugger reports ("System.Data.DataTable", or without its namespace);
 *  IEnumerable for an array or a collection of the BCL's (List<T>, IEnumerable<T>, HashSet<T>, Dictionary<K, V>…). */
const COLLECTION = /(?:^|\.)(?:I?List|IEnumerable|I?ReadOnly(?:Collection|List)|I?Collection|ObservableCollection|HashSet|SortedSet|LinkedList|Queue|Stack|I?Dictionary|SortedDictionary|Immutable(?:Array|List))<.+>$|\[\]$/;
const kindOf = (type) => {
  const t = String(type || '').trim();
  return /(?:^|\.)(DataTable|DataSet|DataView)$/.exec(t)?.[1] || (COLLECTION.test(t) ? 'IEnumerable' : undefined);
};

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
// An IEnumerable's element type, its readable properties (VS's columns), and whether it is a value shown as itself.
const elementType = (e) => `(${e}.GetType().IsArray ? ${e}.GetType().GetElementType() : ${L}.First(${L}.Where(${e}.GetType().GetInterfaces(), i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(System.Collections.Generic.IEnumerable<>))).GetGenericArguments()[0])`;
const propsOf = (t) => `${L}.Where(${t}.GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance), p => p.CanRead && p.GetIndexParameters().Length == 0)`;
const simple = (t) => `(${t}.IsPrimitive || ${t}.IsEnum || ${t} == typeof(string) || ${t} == typeof(decimal) || ${t} == typeof(System.DateTime) || ${t} == typeof(System.DateTimeOffset) || ${t} == typeof(System.TimeSpan) || ${t} == typeof(System.Guid))`;
const valueText = (v) => `(${v} == null ? "\\u0002" : ${v}.ToString())`;

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
    if (this.kind === 'IEnumerable') return [{ index: 0, name: await this.text(`${elementType(this.expression)}.Name`) }];
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
    if (this.kind === 'IEnumerable') {
      const t = elementType(this.expression);
      const text = await this.text(`${simple(t)} ? "\\u0004" + ${t}.Name : string.Join("\\u001e", ${L}.Select(${propsOf(t)}, p => p.Name + "\\u001f" + p.PropertyType.Name))`);
      if (text.startsWith('\u0004')) return [{ name: 'Value', type: text.slice(1) }];
      return text ? text.split(ROW).map((c) => ({ name: c.split(CELL)[0], type: c.split(CELL)[1] })) : [{ name: 'Value', type: '' }];
    }
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
    if (this.kind === 'IEnumerable') return this.number(`${L}.Count(${L}.Cast<object>(${this.expression}))`);
    return this.number(this.kind === 'DataView' ? `${this.expression}.Count` : `${this.table(index)}.Rows.Count`);
  }

  /** Rows [start, start + n): each its cells' text (null for a null or DBNull), or { deleted: true }. */
  async rows(index, start, n) {
    const parse = (text) => (text === DELETED ? { deleted: true } : { cells: text.split(CELL).map((c) => (c === NULL ? null : c)) });
    if (this.kind === 'IEnumerable') {
      // No row-by-row fallback: an IEnumerable has no indexer to ask a row by.
      const t = elementType(this.expression);
      const item = `${simple(t)} ? ${valueText('o')} : string.Join("\\u001f", ${L}.Select(${propsOf(t)}, p => ${valueText('p.GetValue(o)')}))`;
      const text = await this.text(`string.Join("\\u001e", ${L}.Select(${L}.Take(${L}.Skip(${L}.Cast<object>(${this.expression}), ${start}), ${n}), o => ${item}))`);
      return text === '' && n ? (await this.count(index) > start ? [{ cells: [''] }] : []) : text.split(ROW).map(parse);
    }
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

  /** Sets one cell of a DataTable's row (a DataView's by its own order), as VS's UpdateTableRow does: the text converted to
   *  the column's type in the program (Convert.ChangeType, its culture), null for DBNull. Throws the program's error. */
  async setCell(index, row, column, value) {
    const t = this.table(index);
    const r = this.kind === 'DataView' ? `${this.expression}[${row}].Row` : `${t}.Rows[${row}]`;
    // A JSON string is a C# literal too (\" \\ \uXXXX).
    const v = value === null ? '(object)System.DBNull.Value' : `System.Convert.ChangeType(${JSON.stringify(value)}, ${t}.Columns[${column}].DataType, System.Globalization.CultureInfo.CurrentCulture)`;
    await this.eval(`${r}[${column}] = ${v}`);
  }
}

/** A one-sheet .xlsx (a ZIP of stored, uncompressed parts): numbers as numbers where the column is numeric. */
function xlsx(columns, rows) {
  const xml = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const numeric = columns.map((c) => /^(U?Int(16|32|64)|S?Byte|Decimal|Double|Single)$/.test(c.type));
  const cell = (v, i) => (v == null ? '<c/>' : numeric[i] && v !== '' && isFinite(Number(v)) ? `<c><v>${Number(v)}</v></c>` : `<c t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    [columns.map((c) => c.name), ...rows.map((r) => (r.deleted ? columns.map(() => null) : r.cells))].map((cells, n) => `<row>${cells.map((v, i) => (n ? cell(v, i) : cell(v, -1))).join('')}</row>`).join('') +
    '</sheetData></worksheet>';
  const parts = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Arkusz1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  };
  return zip(parts);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A ZIP of stored (uncompressed) files: local headers, then the central directory. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
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
      if (m.type === 'xlsx') {
        await guarded(T.exporting, async () => {
          await fetch(Infinity);
          const file = require('path').join(require('os').tmpdir(), `${name.replace(/[^\w.-]+/g, '_')}-${Date.now()}.xlsx`);
          fs.writeFileSync(file, xlsx(current.columns, current.rows));
          entry.said.xlsx = file;
          if (!process.env.CSHARPSHOOTER_NO_BROWSER) await vscode.env.openExternal(vscode.Uri.file(file));
        });
      }
      if (m.type === 'edit') {
        try {
          await source.setCell(current.index, m.row, m.col, m.value);
        } catch (e) {
          post({ type: 'error', message: `${T.updateError}: ${e.message}` });
          entry.said.editError = e.message;
        }
        // The row as the program has it now: the change, or the value it kept.
        const [row] = await source.rows(current.index, m.row, 1);
        if (row) {
          current.rows[m.row] = row;
          post({ type: 'row', i: m.row, row });
        }
      }
      if (m.type === 'state') entry.said = { ...entry.said, ...m.state };
    });
    panel.webview.onDidReceiveMessage(request);
    panel.webview.html = html();
    return entry;
  };

  const pathOf = registerVariablePaths(context);
  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.visualizeData', (arg) => {
    // debug/variables/context and debug/watch/context give { container, variable: { name, evaluateName, type, ... } }; a
    // member deeper than the frame's own gets its whole expression (Passenger's evaluateName is its name alone).
    const variable = arg?.variable || arg;
    const path = arg?.variable && pathOf(arg);
    return open(path ? { ...variable, evaluateName: path } : variable);
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
  <button id="xlsx">${esc(T.exportExcel)}</button>
</header>
<div class="info" id="info"></div>
<main id="main"><div class="message">${esc(T.fetching)}</div></main>
<footer><span id="status"></span><span id="busy"></span></footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify({ deleted: T.deleted, ascending: T.ascending, descending: T.descending })};
  const $ = (id) => document.getElementById(id);
  let columns = [], rows = [], count = 0, sortBy = -1, sortDir = 0, filter = '', selected = new Set(), last = -1, view = [], pendingAll = null;
  const fill = (s, ...a) => s.replace(/\\{(\\d)\\}/g, (m, i) => a[i]);
  const texts = ${JSON.stringify({ cur: t('Row {0} of {1}'), total: t('Total rows: {0}'), sel: t('Selected rows: {0}') })};
  const fmt = { cur: (n, c) => fill(texts.cur, n, c), total: (n) => fill(texts.total, n), sel: (n) => fill(texts.sel, n) };
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
        (r.deleted ? columns.map(() => '<td></td>') : r.cells.map((c, k) => c == null ? '<td class="null" data-c="' + k + '">NULL</td>' : '<td data-c="' + k + '" title="' + esc(c) + '">' + esc(c) + '</td>')).join('') + '</tr>';
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
  $('xlsx').onclick = () => vscode.postMessage({ type: 'xlsx' });
  // A cell of a DataTable's is edited as in VS: double-click, Enter sets it in the program, Esc leaves it. An empty cell is
  // DBNull (an empty text in a String column).
  let editable = false;
  $('main').addEventListener('dblclick', (e) => {
    const td = e.target.closest('td[data-c]');
    const tr = td?.closest('tr[data-row]');
    if (!editable || !td || tr.classList.contains('deleted')) return;
    const i = Number(tr.dataset.row), c = Number(td.dataset.c);
    const input = document.createElement('input');
    input.value = rows[i].cells[c] ?? '';
    input.style.width = Math.max(80, td.clientWidth) + 'px';
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();
    input.addEventListener('keydown', (k) => {
      if (k.key === 'Escape') render();
      if (k.key !== 'Enter') return;
      const value = input.value === '' && columns[c].type !== 'String' ? null : input.value;
      vscode.postMessage({ type: 'edit', row: i, col: c, value });
    });
    input.addEventListener('blur', () => setTimeout(render, 0));
  });
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
      editable = m.kind !== 'IEnumerable';
    }
    if (m.type === 'row') { rows[m.i] = m.row; $('info').style.display = 'none'; render(); }
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

  return { open, state, kindOf, unquote, csv, xlsx, loadAssemblies, pathOf };
}

module.exports = { registerDataVisualizer, kindOf, unquote };
