// SQL Server Management Studio's Filter Settings for an Object Explorer folder (Tables, Views, Stored Procedures...): the
// server and database, a row per property the SQL Tools Service lets the folder be filtered on (Name, Schema, Owner,
// Create Date...) with its operator and value, the property's description below, Clear Filter, OK and Cancel; SSMS's
// texts (its ObjectExplorer resources), the properties' own from the service in the UI's language.
const vscode = require('vscode');
const { table } = require('../l10n');

const T = table({
  title: 'Filter Settings',
  server: 'Server:',
  database: 'Database:',
  criteria: 'Filter Criteria:',
  property: 'Property',
  operator: 'Operator',
  value: 'Value',
  equals: 'Equals',
  notEquals: 'Does not equal',
  contains: 'Contains',
  notContains: 'Does not contain',
  lessThan: 'Less than',
  lessThanOrEquals: 'Less than or equal',
  greaterThan: 'Greater than',
  greaterThanOrEquals: 'Greater than or equal',
  between: 'Between',
  notBetween: 'Not between',
  clear: 'Clear Filter',
  ok: 'OK',
  cancel: 'Cancel',
  yes: 'True',
  no: 'False',
});

// The service's NodeFilterOperator values, and the operators SSMS offers for each property type
// (NodeFilterPropertyDataType: 0 string, 1 number, 2 boolean, 3 date, 4 choice).
const OP = { equals: 0, notEquals: 1, lessThan: 2, lessThanOrEquals: 3, greaterThan: 4, greaterThanOrEquals: 5, between: 6, notBetween: 7, contains: 8, notContains: 9 };
const OPERATORS = {
  0: ['contains', 'notContains', 'equals', 'notEquals'],
  1: ['equals', 'notEquals', 'lessThan', 'lessThanOrEquals', 'greaterThan', 'greaterThanOrEquals', 'between', 'notBetween'],
  2: ['equals', 'notEquals'],
  3: ['equals', 'notEquals', 'lessThan', 'lessThanOrEquals', 'greaterThan', 'greaterThanOrEquals', 'between', 'notBetween'],
  4: ['equals', 'notEquals'],
};

/** Opens the dialog for a folder: properties are its filterableProperties, filters the ones it has. Resolves to the new
 *  filters (an empty list once cleared), or undefined when cancelled. */
function showFilterDialog({ server, database, properties, filters }) {
  const panel = vscode.window.createWebviewPanel('csharpShooter.sqlFilter', T.title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true });
  let done;
  const result = new Promise((r) => (done = r));
  const dialog = { panel, result };
  dialog.receive = (m) => {
    if (m.type === 'ok') done(m.filters);
    if (m.type === 'ok' || m.type === 'cancel') panel.dispose();
  };
  panel.webview.onDidReceiveMessage(dialog.receive);
  panel.onDidDispose(() => done(undefined));
  const operators = Object.fromEntries(Object.entries(OPERATORS).map(([type, names]) => [type, names.map((n) => ({ value: OP[n], label: T[n] }))]));
  panel.webview.html = html({ server, database, properties, filters: filters || [], operators });
  showFilterDialog.last = dialog;
  return result;
}

function html(data) {
  const nonce = String(Math.random()).slice(2);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const texts = { yes: T.yes, no: T.no };
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-widget-border, var(--vscode-panel-border, #8884)); }
  body { margin: 0; padding: 16px 20px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 14px; }
  .info { display: grid; grid-template-columns: 120px 1fr; gap: 6px 10px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid var(--line); padding: 2px 6px; text-align: left; }
  th { font-weight: normal; background: var(--vscode-editorGroupHeader-tabsBackground, transparent); }
  tr.on td:first-child { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  td:first-child { width: 34%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td:nth-child(2) { width: 26%; }
  input, select { font: inherit; box-sizing: border-box; width: 100%; padding: 2px 4px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid transparent; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  input:focus, select:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .two { display: flex; gap: 4px; }
  .description { min-height: 3.2em; margin-top: 10px; padding: 6px 8px; border: 1px solid var(--line); background: var(--vscode-textBlockQuote-background); }
  .foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  button { font: inherit; min-width: 90px; padding: 4px 14px; border: 1px solid var(--line); border-radius: 3px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
</style></head><body>
<h1>${esc(T.title)}</h1>
<div class="info"><span>${esc(T.server)}</span><span>${esc(data.server)}</span><span>${esc(T.database)}</span><span>${esc(data.database || '')}</span></div>
<div>${esc(T.criteria)}</div>
<table><thead><tr><th>${esc(T.property)}</th><th>${esc(T.operator)}</th><th>${esc(T.value)}</th></tr></thead><tbody id="rows"></tbody></table>
<div class="description" id="description"></div>
<div class="foot"><button id="clear">${esc(T.clear)}</button><button class="primary" id="ok">${esc(T.ok)}</button><button id="cancel">${esc(T.cancel)}</button></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const D = ${JSON.stringify(data)};
  const T = ${JSON.stringify(texts)};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const BETWEEN = [6, 7];
  function valueCell(p, op, value) {
    const v = Array.isArray(value) ? value : [value, ''];
    if (p.type === 2) return '<select data-v="0"><option value=""></option><option value="true"' + (value === true ? ' selected' : '') + '>' + esc(T.yes) + '</option><option value="false"' + (value === false ? ' selected' : '') + '>' + esc(T.no) + '</option></select>';
    if (p.type === 4) return '<select data-v="0"><option value=""></option>' + (p.choices || []).map((c) => '<option value="' + esc(c.value) + '"' + (c.value === value ? ' selected' : '') + '>' + esc(c.displayName || c.value) + '</option>').join('') + '</select>';
    const type = p.type === 3 ? 'date' : p.type === 1 ? 'number' : 'text';
    const one = (i) => '<input type="' + type + '" data-v="' + i + '" value="' + esc(v[i] ?? '') + '">';
    return BETWEEN.includes(op) ? '<div class="two">' + one(0) + one(1) + '</div>' : one(0);
  }
  function row(p) {
    const f = D.filters.find((x) => x.name === p.name);
    const ops = D.operators[p.type] || D.operators[0];
    const op = f ? f.operator : ops[0].value;
    return '<tr data-name="' + esc(p.name) + '"><td>' + esc(p.displayName) + '</td><td><select class="op">' + ops.map((o) => '<option value="' + o.value + '"' + (o.value === op ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('')
      + '</select></td><td class="val">' + valueCell(p, op, f ? f.value : '') + '</td></tr>';
  }
  $('rows').innerHTML = D.properties.map(row).join('');
  const prop = (tr) => D.properties.find((p) => p.name === tr.dataset.name);
  function select(tr) {
    document.querySelectorAll('tr.on').forEach((r) => r.classList.remove('on'));
    tr.classList.add('on');
    $('description').textContent = (prop(tr).description || '').trim();
  }
  document.querySelectorAll('#rows tr').forEach((tr) => {
    tr.addEventListener('focusin', () => select(tr));
    tr.addEventListener('click', () => select(tr));
    tr.querySelector('.op').onchange = (e) => {
      const keep = [...tr.querySelectorAll('[data-v]')].map((i) => i.value);
      tr.querySelector('.val').innerHTML = valueCell(prop(tr), Number(e.target.value), keep.length > 1 ? keep : keep[0]);
    };
  });
  const first = document.querySelector('#rows tr');
  if (first) select(first);
  function filters() {
    const out = [];
    document.querySelectorAll('#rows tr').forEach((tr) => {
      const p = prop(tr);
      const operator = Number(tr.querySelector('.op').value);
      const raw = [...tr.querySelectorAll('[data-v]')].map((i) => i.value.trim());
      if (!raw[0] || (BETWEEN.includes(operator) && !raw[1])) return;
      const cast = (s) => (p.type === 1 ? Number(s) : p.type === 2 ? s === 'true' : s);
      out.push({ name: p.name, operator, value: BETWEEN.includes(operator) ? raw.slice(0, 2).map(cast) : cast(raw[0]) });
    });
    return out;
  }
  $('clear').onclick = () => { document.querySelectorAll('[data-v]').forEach((i) => (i.value = '')); };
  $('ok').onclick = () => vscode.postMessage({ type: 'ok', filters: filters() });
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ok').click(); if (e.key === 'Escape') $('cancel').click(); });
</script></body></html>`;
}

module.exports = { showFilterDialog };
