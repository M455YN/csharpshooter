// What Visual Studio 2026's Properties window (F4) shows for what is selected in the Solution Explorer: a file's rule is
// its item type's BrowseObject rule (None, Compile, Content, EmbeddedResource, ... from the .NET project system, MIT;
// rules/pl/ VS's Polish), a folder's Folder, a project's GeneralBrowseObject; Akcja kompilacji lists the item types of
// ProjectItemsSchema. A change goes to the project file as VS writes it (as in project files VS saved): a file the SDK's
// globs include gets <None Update="x"> for its metadata, and <None Remove="x" /> with <Content Include="x" /> for another
// build action; one the project file includes itself is changed in place; going back to a type whose glob it was removed
// from takes that pair out again. No VS Code in this file.
const fs = require('fs');
const path = require('path');
const { parseXml } = require('./property-rules');

const FILE_RULES = ['Compile', 'None', 'Content', 'EmbeddedResource', 'Resource', 'EditorConfigFiles'];
const no = (v) => /^false$/i.test(v || '');
const yes = (v) => /^true$/i.test(v || '');

/** The BrowseObject rules by name (a file's by item type, 'Folder', 'Project') and the build actions, in a language. */
function loadRules(rulesDir, lang) {
  const dir = lang === 'pl' && fs.existsSync(path.join(rulesDir, 'pl')) ? path.join(rulesDir, 'pl') : rulesDir;
  const read = (file) => parseXml(fs.readFileSync(path.join(dir, file), 'utf8'));
  const rule = (file) => {
    const node = read(file).children.find((c) => c.name === 'Rule');
    const categories = (node.children.find((c) => c.name === 'Rule.Categories')?.children || []).map((c) => ({ name: c.attrs.Name, title: c.attrs.DisplayName || c.attrs.Name }));
    const properties = node.children.filter((c) => /Property$/.test(c.name) && !no(c.attrs.Visible)).map((p) => {
      const source = p.children.find((c) => /\.DataSource$/.test(c.name))?.children[0]?.attrs || {};
      return {
        name: p.attrs.Name,
        title: p.attrs.DisplayName || p.attrs.Name,
        description: p.attrs.Description || '',
        category: p.attrs.Category || 'Misc',
        kind: p.name,
        readOnly: yes(p.attrs.ReadOnly),
        persistedName: source.PersistedName || p.attrs.Name,
        values: p.children.filter((c) => c.name === 'EnumValue').map((v) => ({ value: v.attrs.Name, label: v.attrs.DisplayName || v.attrs.Name })),
      };
    });
    return { name: node.attrs.Name, title: node.attrs.DisplayName, description: node.attrs.Description, categories, properties };
  };
  const rules = Object.fromEntries(FILE_RULES.map((n) => [n, rule(`${n}.BrowseObject.xaml`)]));
  rules.Folder = rule('Folder.xaml');
  rules.Project = rule('GeneralBrowseObject.xaml');
  const itemTypes = ['ProjectItemsSchema.xaml', 'ProjectItemsSchema.CSharp.xaml'].flatMap((f) => read(f).children.find((c) => c.name === 'ProjectSchemaDefinitions')
    .children.filter((c) => c.name === 'ItemType').map((c) => ({ value: c.attrs.Name, label: c.attrs.DisplayName || c.attrs.Name })));
  return { rules, itemTypes };
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const relative = (project, file) => path.relative(path.dirname(project), file).replace(/\//g, '\\');

/** The rows for a file, folder or project: [{ name, title, description, category, value, choices?, readOnly }], with the
 *  rule's title and categories. `items`: MSBuild's items of the project (-getItem), by type. */
function rowsFor(loaded, target, items) {
  const { rules, itemTypes } = loaded;
  if (target.kind === 'project') {
    const values = { FileName: path.basename(target.file), FullPath: path.dirname(target.file) + path.sep, FullProjectFileName: target.file };
    return sheet(rules.Project, (p) => values[p.name] ?? '');
  }
  if (target.kind === 'folder') return sheet(rules.Folder, (p) => (p.name === 'FolderName' ? path.basename(target.file) : target.file));
  const found = findItem(items, target.file);
  const plain = { FileNameAndExtension: path.basename(target.file), FullPath: target.file };
  if (!found) {
    // A file the project does not have (VS shows it only with Pokaż wszystkie pliki): its name and path.
    const shown = sheet(rules.None, (p) => plain[p.name]);
    return { ...shown, rows: shown.rows.filter((r) => r.name in plain) };
  }
  const rule = rules[found.type] || rules.None; // an item type with no BrowseObject rule of its own gets None's
  const known = itemTypes.map((t) => t.value);
  const extra = Object.keys(items).filter((t) => t !== 'AvailableItemName' && !known.includes(t) && (items[t] || []).some((i) => same(i.FullPath || '', target.file)));
  const available = (items.AvailableItemName || []).map((i) => i.Identity).filter((t) => !known.includes(t) && !extra.includes(t));
  return sheet(rule, (p) => {
    if (p.name === '{}{ItemType}') return found.type;
    if (p.name in plain) return plain[p.name];
    return found.item[p.persistedName] ?? '';
  }, (p) => (p.name === '{}{ItemType}' ? [...itemTypes, ...[...extra, ...available].map((t) => ({ value: t, label: t }))] : undefined), found.type);
}

function sheet(rule, valueOf, choicesOf = () => undefined, itemType) {
  return {
    title: rule.title,
    description: rule.description,
    itemType,
    categories: rule.categories,
    rows: rule.properties.map((p) => {
      let value = valueOf(p) ?? '';
      let choices = choicesOf(p) || (p.values.length ? p.values : undefined);
      // An enum the file does not set shows its first value (Nie kopiuj), as VS shows the default.
      if (choices && value === '' && p.values.length) value = p.values[0].value;
      if (choices && value && !choices.some((c) => c.value.toLowerCase() === String(value).toLowerCase())) choices = [...choices, { value, label: value }];
      return { name: p.name, title: p.title, description: p.description, category: p.category, value, choices, readOnly: p.readOnly };
    }),
  };
}

/** The item a file is in the project as: its type and metadata (the first of Compile, then the schema's order). */
function findItem(items, file) {
  const order = ['Compile', 'Content', 'EmbeddedResource', 'None', 'Resource', 'Page', 'ApplicationDefinition', 'AdditionalFiles', 'EditorConfigFiles'];
  const types = [...order.filter((t) => items[t]), ...Object.keys(items).filter((t) => !order.includes(t) && t !== 'AvailableItemName')];
  for (const type of types) {
    const item = (items[type] || []).find((i) => i.FullPath && same(i.FullPath, file));
    if (item) return { type, item };
  }
  return undefined;
}

// ---------- The project file.

const samePath = (a, b) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every item element of the project file naming one path exactly: { type, op (Include/Update/Remove), start, end, body, indent }. */
function elements(text, rel) {
  const out = [];
  for (const m of text.matchAll(/([ \t]*)<([\w.]+)\s+(Include|Update|Remove)="([^"]*)"([^>]*?)(?:\/>|>([\s\S]*?)<\/\2\s*>)/g)) {
    if (!samePath(m[4], rel) || /^(PackageReference|ProjectReference|Reference|Using|Folder)$/.test(m[2])) continue;
    out.push({ type: m[2], op: m[3], path: m[4], attrs: m[5], start: m.index + m[1].length, end: m.index + m[0].length, body: m[6], indent: m[1] });
  }
  return out;
}

/** The project file's indents: its ItemGroups', and one step in. */
function layout(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const group = /^([ \t]*)<(ItemGroup|PropertyGroup)\b/m.exec(text)?.[1] ?? '  ';
  return { eol, group, item: `${group}  `, meta: `${group}    ` };
}

/** Text with one element (and its line, and an ItemGroup left empty) removed. */
function cut(text, e) {
  const lineStart = text.lastIndexOf('\n', e.start - 1) + 1;
  const after = /^[^\S\r\n]*\r?\n/.exec(text.slice(e.end))?.[0] ?? '';
  let next = text.slice(0, text.slice(lineStart, e.start).trim() ? e.start : lineStart) + text.slice(e.end + after.length);
  // An ItemGroup left empty goes, with the blank line before it (the one a new group gets).
  next = next.replace(/(^[ \t]*\r?\n)?^[ \t]*<ItemGroup\s*>\s*<\/ItemGroup>[^\S\r\n]*\r?\n/gm, '');
  return next;
}

/** A new ItemGroup with these lines, after the project file's last ItemGroup (else before </Project>). */
function addGroup(text, lines) {
  const { eol, group } = layout(text);
  const block = `${group}<ItemGroup>${eol}${lines.join(eol)}${eol}${group}</ItemGroup>${eol}`;
  const last = text.lastIndexOf('</ItemGroup>');
  if (last >= 0) {
    const lineEnd = text.indexOf('\n', last);
    const at = lineEnd < 0 ? text.length : lineEnd + 1;
    return `${text.slice(0, at)}${eol}${block}${text.slice(at)}`;
  }
  const close = text.lastIndexOf('</Project>');
  return `${text.slice(0, close)}${block}${eol}${text.slice(close)}`;
}

/** An element's metadata set (value '' removes it), the element written back in the project file's way. */
function withMetadata(text, e, name, value) {
  const { eol } = layout(text);
  const metas = [...(e.body || '').matchAll(/<([\w.]+)>([\s\S]*?)<\/\1>/g)].map((m) => [m[1], m[2]]);
  const at = metas.findIndex(([n]) => n === name);
  if (value === '') {
    if (at >= 0) metas.splice(at, 1);
  } else if (at >= 0) metas[at][1] = xml(value);
  else metas.push([name, xml(value)]);
  const open = `<${e.type} ${e.op}="${e.path}"${e.attrs.replace(/\s+$/, '')}`;
  const element = metas.length ? `${open}>${eol}${metas.map(([n, v]) => `${e.indent}  <${n}>${v}</${n}>${eol}`).join('')}${e.indent}</${e.type}>` : `${open} />`;
  return { text: text.slice(0, e.start) + element + text.slice(e.end), empty: !metas.length };
}

/** A file's metadata (CopyToOutputDirectory, Generator, CustomToolNamespace) set as VS sets it. */
function setMetadata(text, project, file, type, name, value) {
  const rel = relative(project, file);
  const own = elements(text, rel).find((e) => e.type === type && e.op !== 'Remove');
  if (own) {
    const next = withMetadata(text, own, name, value);
    // An Update left with nothing in it goes; an Include stays (it is what puts the file in the project).
    return own.op === 'Update' && next.empty ? cut(text, own) : next.text;
  }
  if (value === '') return text;
  const { item, meta } = layout(text);
  return addGroup(text, [`${item}<${type} Update="${xml(rel)}">`, `${meta}<${name}>${xml(value)}</${name}>`, `${item}</${type}>`]);
}

/** A file's build action changed from one item type to another, as VS changes it. */
function setItemType(text, project, file, from, to) {
  if (from === to) return text;
  const rel = relative(project, file);
  const { item } = layout(text);
  let next = text;
  const find = (type, op) => elements(next, rel).find((e) => e.type === type && (op ? e.op === op : e.op !== 'Remove'));
  const include = find(from, 'Include');
  const update = find(from, 'Update');
  const metadata = (include || update)?.body?.trim() ? include?.body ?? update.body : '';
  const removedFromTo = find(to, 'Remove');
  // From: an Include of its own goes; else the file leaves its glob (an Update of it goes, its metadata moving along).
  if (include) next = cut(next, include);
  else {
    if (update) next = cut(next, update);
    next = addGroup(next, [`${item}<${from} Remove="${xml(rel)}" />`]);
  }
  // To: back into the glob it was removed from, else an Include of its own.
  if (removedFromTo) next = cut(next, find(to, 'Remove'));
  if (!removedFromTo || metadata) {
    next = addGroup(next, [`${item}<${to} ${removedFromTo ? 'Update' : 'Include'}="${xml(rel)}" />`]);
    if (metadata) {
      for (const [, n, v] of metadata.matchAll(/<([\w.]+)>([\s\S]*?)<\/\1>/g)) {
        next = setMetadata(next, project, file, to, n, v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      }
    }
  }
  return next;
}

module.exports = { loadRules, rowsFor, findItem, setMetadata, setItemType, elements, FILE_RULES };
