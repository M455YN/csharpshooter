// A project's properties as Visual Studio 2026's project Properties window has them: its pages are the MSBuild XAML rules
// the .NET project system ships (rules/, from dotnet/project-system, MIT; rules/pl/ VS's Polish ones), their properties'
// values read from the project file (unevaluated) and from MSBuild (evaluated), shown or hidden by each one's
// VisibilityCondition, and written back to the project file as VS writes them. Where VS's "intercepting value providers"
// stand between a property and the project file (a synthetic property such as ResourceSpecificationKind, TargetFramework
// written as an alias, build events as targets), the same mapping is made here. No VS Code in this file.
const fs = require('fs');
const path = require('path');

const RULE_FILES = ['ApplicationPropertyPage.xaml', 'ApplicationPropertyPage.CSharp.xaml', 'ReferencesPage.CSharp.xaml', 'BuildPropertyPage.xaml',
  'PackagePropertyPage.xaml', 'CodeAnalysisPropertyPage.xaml', 'DebugPropertyPage.xaml', 'ResourcesPropertyPage.xaml', 'SettingsPropertyPage.xaml'];

// ---------- XML: elements, attributes and text, enough for the rules and for reading a project file.

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]
  ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w.:-]+)\s*>|<([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of text.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) stack.length > 1 && stack.pop();
    else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const node = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6]) top.text += decode(m[6]);
  }
  return root;
}

const kids = (node, name) => node.children.filter((c) => c.name === name);
const kid = (node, name) => node.children.find((c) => c.name === name);

// ---------- Rules: pages, categories, properties.

function ruleProperty(node, ruleSource) {
  const kind = node.name;
  const own = kid(node, `${kind}.DataSource`)?.children[0]?.attrs;
  const data = { ...ruleSource, ...(own || {}) };
  const metadata = {};
  for (const pair of kids(kid(node, `${kind}.Metadata`) || { children: [] }, 'NameValuePair')) {
    metadata[pair.attrs.Name] = pair.attrs.Value ?? kid(pair, 'NameValuePair.Value')?.text.trim() ?? '';
  }
  const editors = kids(kid(node, `${kind}.ValueEditors`) || { children: [] }, 'ValueEditor').map((e) => {
    const meta = {};
    for (const pair of kids(kid(e, 'ValueEditor.Metadata') || { children: [] }, 'NameValuePair')) meta[pair.attrs.Name] = pair.attrs.Value ?? '';
    return { type: e.attrs.EditorType, metadata: meta };
  });
  return {
    kind,
    name: node.attrs.Name,
    title: node.attrs.DisplayName || node.attrs.Name,
    description: node.attrs.Description || '',
    category: node.attrs.Category || 'General',
    helpUrl: node.attrs.HelpUrl || '',
    subtype: node.attrs.Subtype || '',
    visible: node.attrs.Visible !== 'False',
    readOnly: node.attrs.ReadOnly === 'True',
    enumProvider: node.attrs.EnumProvider || '',
    values: kids(node, 'EnumValue').map((v) => ({ value: v.attrs.Name, label: v.attrs.DisplayName || v.attrs.Name, isDefault: v.attrs.IsDefault === 'True' })),
    persistence: data.Persistence || 'ProjectFile',
    persistedName: data.PersistedName || node.attrs.Name,
    perConfiguration: data.HasConfigurationCondition === 'True',
    metadata,
    editors,
  };
}

function readRule(file) {
  const rule = kid(parseXml(fs.readFileSync(file, 'utf8')), 'Rule');
  const source = kid(rule, 'Rule.DataSource')?.children[0]?.attrs || {};
  return {
    name: rule.attrs.Name,
    title: rule.attrs.DisplayName || rule.attrs.Name,
    description: rule.attrs.Description || '',
    order: Number(rule.attrs.Order || 10000),
    extend: rule.attrs.OverrideMode === 'Extend',
    categories: kids(kid(rule, 'Rule.Categories') || { children: [] }, 'Category')
      .map((c) => ({ name: c.attrs.Name, title: c.attrs.DisplayName || c.attrs.Name, description: c.attrs.Description || '' })),
    properties: rule.children.filter((c) => /Property$/.test(c.name)).map((p) => ruleProperty(p, source)),
  };
}

/** The pages, in VS's order: each rule with what its .CSharp file extends it with (categories, properties). */
function loadPages(rulesDir, lang) {
  const dir = lang === 'pl' && fs.existsSync(path.join(rulesDir, 'pl')) ? path.join(rulesDir, 'pl') : rulesDir;
  const pages = [];
  for (const file of RULE_FILES) {
    const rule = readRule(path.join(dir, file));
    const base = pages.find((p) => p.name === rule.name);
    if (rule.extend && base) {
      for (const c of rule.categories) {
        const at = base.categories.findIndex((x) => x.name === c.name);
        if (at >= 0) base.categories[at] = c;
        else base.categories.push(c);
      }
      base.properties.push(...rule.properties);
    } else if (!rule.extend) {
      pages.push(rule);
    }
  }
  return pages.sort((a, b) => a.order - b.order);
}

// ---------- VisibilityCondition: VS's small s-expression language.

function parseExpression(text) {
  const tokens = [...text.matchAll(/\(|\)|"((?:[^"\\]|\\.)*)"|[^\s()"]+/g)].map((m) => (m[1] !== undefined ? { s: m[1] } : m[0]));
  let at = 0;
  const read = () => {
    const tok = tokens[at++];
    if (tok === '(') {
      const list = [];
      while (tokens[at] !== ')' && at < tokens.length) list.push(read());
      at++;
      return list;
    }
    return tok;
  };
  return read();
}

const versionAtLeast = (have, want) => {
  const a = String(have || '').replace(/^v/i, '').split('.').map(Number);
  const b = String(want).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
};

/** Evaluates a condition with `ctx`: value(rule, property) → its evaluated value, capabilities, msbuild(name). */
function evaluateCondition(text, ctx) {
  if (!text || !text.trim()) return true;
  // A value: a literal, or what (unevaluated "Rule" "Property") / (evaluated "Rule" "Property") give.
  const value = (x) => {
    if (Array.isArray(x)) {
      if (x[0] === 'unevaluated') return String((ctx.unevaluated || ctx.value)(value(x[1]), value(x[2])) ?? '');
      if (x[0] === 'evaluated') return String(ctx.value(value(x[1]), value(x[2])) ?? '');
      return String(run(x));
    }
    return typeof x === 'object' ? x.s : x;
  };
  const run = (expr) => {
    if (!Array.isArray(expr)) return value(expr) === 'true' || value(expr) === true;
    const [fn, ...args] = expr;
    switch (fn) {
      case 'and': return args.every(run);
      case 'or': return args.some(run);
      case 'not': return !run(args[0]);
      case 'eq': return value(args[0]).toLowerCase() === value(args[1]).toLowerCase();
      case 'ne': return value(args[0]).toLowerCase() !== value(args[1]).toLowerCase();
      case 'has-evaluated-value': return String(ctx.value(value(args[0]), value(args[1])) ?? '').toLowerCase() === String(value(args[2])).toLowerCase();
      case 'has-project-capability': return ctx.capabilities.has(String(value(args[0])).toLowerCase());
      case 'has-net-core-app-version-or-greater':
        return ctx.msbuild('TargetFrameworkIdentifier') === '.NETCoreApp' && versionAtLeast(ctx.msbuild('TargetFrameworkVersion'), value(args[0]));
      case 'has-net-framework': return ctx.msbuild('TargetFrameworkIdentifier') === '.NETFramework';
      case 'has-csharp-lang-version-or-greater': {
        const lang = ctx.msbuild('LangVersion') || ctx.msbuild('MaxSupportedLangVersion');
        return /^(latest|preview|default|latestmajor)$/i.test(lang) || versionAtLeast(lang, value(args[0]));
      }
      default: return true; // a function VS knows and this does not: the property is shown rather than lost
    }
  };
  try {
    return run(parseExpression(text));
  } catch {
    return true;
  }
}

// ---------- The project file: properties and items read and written where VS writes them, the rest kept as it was.

const conditionKey = (condition) => {
  if (!condition) return '';
  const m = /'\$\(Configuration\)(\|\$\(Platform\))?'\s*==\s*'([^']*)'/.exec(condition);
  return m ? m[2].toLowerCase() : `?${condition}`;
};
/** The PropertyGroup condition VS writes for a configuration and platform (Any CPU as AnyCPU). */
const configCondition = (configuration, platform) => `'$(Configuration)|$(Platform)'=='${configuration}|${String(platform || 'AnyCPU').replace(/\s/g, '')}'`;

/** Spans of the project's own top-level PropertyGroups (none inside a Target or Choose). */
function propertyGroups(text) {
  const out = [];
  const blocked = [...text.matchAll(/<(Target|Choose)\b[\s\S]*?<\/\1>/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/<PropertyGroup\b([^>]*?)(\/>|>([\s\S]*?)<\/PropertyGroup>)/g)) {
    if (blocked.some(([a, b]) => m.index > a && m.index < b)) continue;
    const condition = /Condition\s*=\s*"([^"]*)"/.exec(m[1])?.[1] || /Condition\s*=\s*'([^']*)'/.exec(m[1])?.[1] || '';
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    out.push({ start: m.index, end: m.index + m[0].length, selfClosing: m[2] === '/>', condition: decode(condition), key: conditionKey(decode(condition)),
      bodyStart, bodyEnd: m[2] === '/>' ? bodyStart : bodyStart + (m[3] || '').length });
  }
  return out;
}

const elementRe = (name) => new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}>)`, 'g');

/** A property's value in the project file: the last definition in a group without a condition or with the given
 *  configuration's (as MSBuild reads them, the last wins); undefined when the project file does not set it. */
function readProperty(text, name, configKey) {
  let found;
  for (const g of propertyGroups(text)) {
    if (g.key && g.key !== configKey && !(configKey && g.key === configKey.split('|')[0])) continue;
    for (const m of text.slice(g.bodyStart, g.bodyEnd).matchAll(elementRe(name))) {
      if (/Condition\s*=/.test(m[1] || '')) continue;
      found = decode(m[2] ?? '').trim();
    }
  }
  return found;
}

/** Sets a property (null removes it): where it is defined in a group of that scope, else in the first group of it,
 *  else in a new group VS's way (after the last PropertyGroup); a group left empty by a removal goes too. */
function writeProperty(text, name, value, configKey, condition) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const groups = propertyGroups(text).filter((g) => g.key === (configKey || ''));
  const at = (g) => [...text.slice(g.bodyStart, g.bodyEnd).matchAll(elementRe(name))].filter((m) => !/Condition\s*=/.test(m[1] || '')).pop();
  const holder = [...groups].reverse().find((g) => at(g));
  if (holder) {
    const m = at(holder);
    const start = holder.bodyStart + m.index;
    const end = start + m[0].length;
    if (value === null) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const onlyIndent = !text.slice(lineStart, start).trim();
      const lineEnd = text.indexOf('\n', end);
      const cutFrom = onlyIndent ? lineStart : start;
      const cutTo = onlyIndent && lineEnd >= 0 && !text.slice(end, lineEnd).trim() ? lineEnd + 1 : end;
      let next = text.slice(0, cutFrom) + text.slice(cutTo);
      const left = propertyGroups(next).find((g) => g.start === holder.start);
      if (left && !left.selfClosing && !next.slice(left.bodyStart, left.bodyEnd).trim()) {
        let gLine = next.lastIndexOf('\n', left.start - 1) + 1;
        const gEnd = next.indexOf('\n', left.end);
        // The blank line before it goes with it, as a group is added with one.
        const blank = /(\r?\n)[ \t]*\r?\n$/.exec(next.slice(0, gLine));
        if (blank && !next.slice(gLine, left.start).trim()) gLine -= blank[0].length - blank[1].length;
        next = next.slice(0, !next.slice(gLine, left.start).trim() ? gLine : left.start) + next.slice(gEnd >= 0 && !next.slice(left.end, gEnd).trim() ? gEnd + 1 : left.end);
      }
      return next;
    }
    return text.slice(0, start) + `<${name}${m[1] || ''}>${encode(value)}</${name}>` + text.slice(end);
  }
  if (value === null) return text;
  const target = groups.find((g) => !g.selfClosing);
  if (target) {
    const body = text.slice(target.bodyStart, target.bodyEnd);
    const indent = /\n([ \t]+)<\w/.exec(body)?.[1] || `${groupIndent(text, target.start)}  `;
    const closeLine = text.lastIndexOf('\n', target.bodyEnd - 1);
    // Before the line break that ends the last child (its \r too), so the group's closing tag keeps its own line.
    const insertAt = closeLine >= target.bodyStart ? closeLine - (text[closeLine - 1] === '\r' ? 1 : 0) : target.bodyEnd;
    return text.slice(0, insertAt) + `${eol}${indent}<${name}>${encode(value)}</${name}>` + text.slice(insertAt);
  }
  const all = propertyGroups(text);
  const after = all.length ? all[all.length - 1].end : text.indexOf('>', text.indexOf('<Project')) + 1;
  const indent = all.length ? groupIndent(text, all[all.length - 1].start) : '  ';
  const cond = configKey ? ` Condition="${encode(condition).replace(/"/g, '&quot;')}"` : '';
  return text.slice(0, after) + `${eol}${eol}${indent}<PropertyGroup${cond}>${eol}${indent}  <${name}>${encode(value)}</${name}>${eol}${indent}</PropertyGroup>` + text.slice(after);
}

const groupIndent = (text, at) => /[ \t]*$/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1, at))[0];

/** <Target Name="PreBuild" BeforeTargets="PreBuildEvent"><Exec Command="..." /></Target>, as VS writes a build event. */
function readBuildEvent(text, which) {
  const m = new RegExp(`<Target\\s+Name="${which}"[^>]*>([\\s\\S]*?)</Target>`).exec(text);
  const exec = m && /<Exec\s+Command="([^"]*)"/.exec(m[1]);
  return exec ? decode(exec[1]) : '';
}

function writeBuildEvent(text, which, command) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const re = new RegExp(`([ \\t]*)<Target\\s+Name="${which}"[^>]*>[\\s\\S]*?</Target>[ \\t]*(\\r?\\n)?`);
  const attr = which === 'PreBuild' ? 'BeforeTargets="PreBuildEvent"' : 'AfterTargets="PostBuildEvent"';
  const quoted = encode(command).replace(/"/g, '&quot;').replace(/\r?\n/g, '&#xD;&#xA;');
  const block = (indent) => `${indent}<Target Name="${which}" ${attr}>${eol}${indent}  <Exec Command="${quoted}" />${eol}${indent}</Target>${eol}`;
  const m = re.exec(text);
  if (m) return text.slice(0, m.index) + (command ? block(m[1]) : '') + text.slice(m.index + m[0].length);
  if (!command) return text;
  const close = text.lastIndexOf('</Project>');
  return `${text.slice(0, close).replace(/\s*$/, eol + eol)}${block('  ')}${text.slice(close)}`;
}

/** The project file's own <Using Include/Remove> items. */
function readUsings(text) {
  return [...text.matchAll(/<Using\s+(Include|Remove)="([^"]*)"([^>]*?)\/?>/g)].map((m) => ({ kind: m[1], name: decode(m[2]), alias: /Alias="([^"]*)"/.exec(m[3])?.[1] || '', isStatic: /Static="true"/i.test(m[3]) }));
}

function writeUsing(text, kind, name, add) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const re = new RegExp(`[ \\t]*<Using\\s+${kind}="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*?/?>(?:</Using>)?[ \\t]*\\r?\\n?`);
  if (!add) return text.replace(re, '');
  if (re.test(text)) return text;
  const group = /<ItemGroup>(?:(?!<\/ItemGroup>)[\s\S])*?<Using\s/.exec(text);
  if (group) {
    const at = group.index + group[0].lastIndexOf('<Using');
    const indent = groupIndent(text, at);
    return `${text.slice(0, at)}<Using ${kind}="${encode(name)}" />${eol}${indent}${text.slice(at)}`;
  }
  const close = text.lastIndexOf('</Project>');
  return `${text.slice(0, close).replace(/\s*$/, eol + eol)}  <ItemGroup>${eol}    <Using ${kind}="${encode(name)}" />${eol}  </ItemGroup>${eol}${text.slice(close)}`;
}

// ---------- VS's intercepting value providers, as maps between a page's property and the project file.

/** Each: get(io) → { u, e } (u: the project file's, e: evaluated); set(io, value) → [{ name, value|null }] writes. io gives
 *  u(name), e(name), items(name) and the project file's text. A property not here is its PersistedName as it is. */
const INTERCEPTORS = {
  TargetMultipleFrameworks: {
    get: (io) => ({ u: io.u('TargetFrameworks') ? 'true' : 'false', e: io.e('TargetFrameworks') ? 'true' : 'false' }),
    set: (io, v) => (v === 'true'
      ? (io.u('TargetFramework') ? [{ name: 'TargetFrameworks', value: io.u('TargetFramework') }, { name: 'TargetFramework', value: null }] : [])
      : (io.u('TargetFrameworks') ? [{ name: 'TargetFramework', value: io.u('TargetFrameworks').split(';')[0] }, { name: 'TargetFrameworks', value: null }] : [])),
  },
  InterceptedTargetFramework: {
    get: (io) => ({ u: io.e('TargetFrameworkMoniker'), e: io.e('TargetFrameworkMoniker') }),
    set: (io, v) => {
      const alias = io.items('SupportedTargetFramework').find((i) => i.Identity === v)?.Alias;
      if (!alias) return [];
      const net5 = /^net([5-9]|\d\d)/.test(alias);
      const platform = net5 && io.e('TargetPlatformIdentifier') ? `-${platformAlias(io, io.e('TargetPlatformIdentifier'))}${io.e('TargetPlatformVersion') || ''}` : '';
      return [{ name: 'TargetFramework', value: alias + platform }, ...(net5 ? [] : [{ name: 'TargetPlatformIdentifier', value: null }, { name: 'TargetPlatformVersion', value: null }, { name: 'SupportedOSPlatformVersion', value: null }])];
    },
  },
  TargetPlatformIdentifier: {
    get: (io) => ({ u: io.e('TargetPlatformIdentifier'), e: io.e('TargetPlatformIdentifier') }),
    set: (io, v) => [{ name: 'TargetFramework', value: frameworkAlias(io) + (v ? `-${platformAlias(io, v)}` : '') },
      { name: 'TargetPlatformVersion', value: null }, { name: 'SupportedOSPlatformVersion', value: null }],
  },
  TargetPlatformVersion: {
    get: (io) => ({ u: io.e('TargetPlatformVersion'), e: io.e('TargetPlatformVersion') }),
    set: (io, v) => [{ name: 'TargetFramework', value: `${frameworkAlias(io)}-${platformAlias(io, io.e('TargetPlatformIdentifier'))}${v || ''}` }],
  },
  ResourceSpecificationKind: {
    get: (io) => {
      const kind = (get) => (get('ApplicationIcon') || get('ApplicationManifest') ? 'IconAndManifest' : get('Win32Resource') ? 'ResourceFile' : 'IconAndManifest');
      return { u: kind(io.u), e: kind(io.e) };
    },
    set: (io, v) => (v === 'ResourceFile' ? [{ name: 'ApplicationIcon', value: null }, { name: 'ApplicationManifest', value: null }] : [{ name: 'Win32Resource', value: null }]),
  },
  ApplicationManifestKind: {
    get: (io) => {
      const kind = (get) => (get('ApplicationManifest') ? 'CustomManifest' : /^true$/i.test(get('NoWin32Manifest') || '') ? 'NoManifest' : 'DefaultManifest');
      return { u: kind(io.u), e: kind(io.e) };
    },
    set: (io, v) => (v === 'NoManifest' ? [{ name: 'ApplicationManifest', value: null }, { name: 'NoWin32Manifest', value: 'true' }]
      : v === 'DefaultManifest' ? [{ name: 'ApplicationManifest', value: null }, { name: 'NoWin32Manifest', value: null }]
        : [{ name: 'NoWin32Manifest', value: null }]),
  },
  ApplicationManifestPath: {
    get: (io) => ({ u: io.u('ApplicationManifest') || '', e: io.e('ApplicationManifest') }),
    set: (io, v) => [{ name: 'ApplicationManifest', value: relative(io, v) || null }],
  },
  ApplicationIcon: { set: (io, v) => [{ name: 'ApplicationIcon', value: relative(io, v) || null }] },
  Win32Resource: { set: (io, v) => [{ name: 'Win32Resource', value: relative(io, v) || null }] },
  DefineConstants: {
    // The symbols the project adds to what it inherits: $(DefineConstants);A;B, shown as A;B.
    get: (io) => ({ u: (io.u('DefineConstants') || '').replace(/^\$\(DefineConstants\);?/, ''), e: io.e('DefineConstants') }),
    set: (io, v) => {
      const own = v.split(/[;,\s]+/).filter(Boolean);
      return [{ name: 'DefineConstants', value: own.length ? `$(DefineConstants);${[...new Set(own)].join(';')}` : null }];
    },
  },
  GenerateDocumentationFile: { set: (io, v) => [{ name: 'GenerateDocumentationFile', value: v }, ...(v === 'false' ? [{ name: 'DocumentationFile', value: null }] : [])] },
  DebugType: {
    get: (io) => ({ u: io.u('DebugType') === 'pdbonly' ? 'full' : io.u('DebugType'), e: io.e('DebugType') === 'pdbonly' ? 'full' : io.e('DebugType') }),
  },
  WarningLevelOverridden: { get: (io) => ({ u: undefined, e: Number(io.e('EffectiveAnalysisLevel')) >= 5 ? 'true' : 'false' }), set: () => [] },
  PackageLicenseKind: {
    get: (io) => {
      const kind = (get) => (get('PackageLicenseExpression') ? 'Expression' : get('PackageLicenseFile') ? 'File' : 'None');
      return { u: kind(io.u), e: kind(io.e) };
    },
    set: (io, v) => (v === 'Expression' ? [{ name: 'PackageLicenseFile', value: null }] : v === 'File' ? [{ name: 'PackageLicenseExpression', value: null }]
      : [{ name: 'PackageLicenseFile', value: null }, { name: 'PackageLicenseExpression', value: null }, { name: 'PackageRequireLicenseAcceptance', value: null }]),
  },
  ImplicitUsings: {
    get: (io) => {
      const b = (v) => (/^enable$/i.test(v || '') ? 'true' : /^disable$/i.test(v || '') ? 'false' : v);
      return { u: b(io.u('ImplicitUsings')), e: b(io.e('ImplicitUsings')) };
    },
    set: (io, v) => [{ name: 'ImplicitUsings', value: v === 'true' ? 'enable' : v === 'false' ? 'disable' : v || null }],
  },
  AssemblyVersion: { get: (io) => ({ u: io.u('AssemblyVersion'), e: io.e('AssemblyVersion') || versionOf(io, 4) }) },
  FileVersion: { get: (io) => ({ u: io.u('FileVersion'), e: io.e('FileVersion') || versionOf(io, 4) }) },
  PreBuildEvent: { get: (io) => ({ u: readBuildEvent(io.text, 'PreBuild'), e: readBuildEvent(io.text, 'PreBuild') }), set: (io, v) => [{ target: 'PreBuild', value: v }] },
  PostBuildEvent: { get: (io) => ({ u: readBuildEvent(io.text, 'PostBuild'), e: readBuildEvent(io.text, 'PostBuild') }), set: (io, v) => [{ target: 'PostBuild', value: v }] },
};

const frameworkAlias = (io) => io.items('SupportedTargetFramework').find((i) => i.Identity === io.e('TargetFrameworkMoniker'))?.Alias || io.u('TargetFramework') || io.e('TargetFramework');
const platformAlias = (io, id) => (io.items('SdkSupportedTargetPlatformIdentifier').find((i) => i.Identity.toLowerCase() === String(id).toLowerCase())?.Identity || String(id)).toLowerCase();
const relative = (io, file) => (file && path.isAbsolute(file) && !path.relative(path.dirname(io.project), file).startsWith('..') ? path.relative(path.dirname(io.project), file) : file);
const versionOf = (io, parts) => {
  const v = (io.e('Version') || '1.0.0').split('-')[0].split('.').map((x) => Number(x) || 0);
  while (v.length < parts) v.push(0);
  return v.slice(0, parts).join('.');
};

/** A property's value: the project file's (u, undefined when it does not set it) and MSBuild's (e). */
function valueOf(prop, io) {
  const own = INTERCEPTORS[prop.name]?.get?.(io);
  if (own) return own;
  return { u: io.u(prop.persistedName), e: io.e(prop.persistedName) };
}

/** The writes for setting a property ([{ name, value }] or [{ target, value }]). */
function writesFor(prop, io, value) {
  const own = INTERCEPTORS[prop.name]?.set;
  if (own) return own(io, value);
  return [{ name: prop.persistedName, value: value === '' ? null : value }];
}

/** Applies writes to a project file's text. */
function applyWrites(text, writes, configKey, condition) {
  let next = text;
  for (const w of writes) {
    if (w.target) next = writeBuildEvent(next, w.target, w.value || '');
    else next = writeProperty(next, w.name, w.value ?? null, configKey, condition);
  }
  return next;
}

/** The MSBuild property names a set of pages needs evaluated (their properties' and the interceptors'). */
function evaluatedNames(pages) {
  const names = new Set(['TargetFramework', 'TargetFrameworks', 'TargetFrameworkMoniker', 'TargetFrameworkIdentifier', 'TargetFrameworkVersion', 'TargetPlatformIdentifier',
    'TargetPlatformVersion', 'LangVersion', 'MaxSupportedLangVersion', 'AvailablePlatforms', 'Configurations', 'Platforms', 'EffectiveAnalysisLevel', 'Version',
    'ApplicationIcon', 'ApplicationManifest', 'Win32Resource', 'NoWin32Manifest', 'PackageLicenseExpression', 'PackageLicenseFile', 'DefineConstants', 'DebugType',
    'ImplicitUsings', 'AssemblyVersion', 'FileVersion', 'MSBuildProjectName', 'UseWPF', 'UseWindowsForms', 'OutputType']);
  for (const page of pages) for (const p of page.properties) if (!INTERCEPTORS[p.name]?.get) names.add(p.persistedName);
  return [...names].filter((n) => /^\w+$/.test(n));
}

module.exports = {
  RULE_FILES, parseXml, loadPages, parseExpression, evaluateCondition, propertyGroups, readProperty, writeProperty, readBuildEvent, writeBuildEvent,
  readUsings, writeUsing, valueOf, writesFor, applyWrites, evaluatedNames, configCondition, conditionKey, INTERCEPTORS,
};
