// A solution's configurations as Visual Studio's Configuration Manager edits them, following Microsoft's
// vs-solutionpersistence (MIT), the library VS and dotnet read and write .sln and .slnx with: the solution's build types
// (configurations) and platforms, and for each project in each of their pairs the project's build type and platform and
// whether it builds and deploys. An .sln keeps that whole matrix (ProjectConfigurationPlatforms' ActiveCfg, Build.0 and
// Deploy.0 lines); an .slnx only how it differs from the defaults (the solution's names, C# projects on AnyCPU, built, not
// deployed), as the fewest <BuildType>, <Platform>, <Build> and <Deploy> rules, made as the library makes them.
const fs = require('fs');
const path = require('path');

const DIMENSIONS = ['build', 'deploy', 'buildType', 'platform']; // the order the library makes its rules in
const TAGS = { buildType: 'BuildType', platform: 'Platform', build: 'Build', deploy: 'Deploy' };
const FOLDER = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

/** "Any CPU" is AnyCPU (PlatformNames.Canonical). */
const canonical = (p) => (/^any cpu$/i.test(p || '') ? 'AnyCPU' : p);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const samePlatform = (a, b) => same(canonical(a), canonical(b));
const indexOf = (list, name, eq = same) => list.findIndex((x) => eq(x, name));

/** A project type's own rules (ProjectTypeTable.BuiltInTypes), by extension: CLR projects build as AnyCPU on every
 *  solution platform, C++ ones as x64 / Win32 for Any CPU / x86; null for the types that have no configurations. */
function typeRules(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.csproj', '.vbproj', '.fsproj', '.webproj'].includes(ext)) return [{ dimension: 'platform', buildType: '', platform: '', value: 'AnyCPU' }];
  if (ext === '.vcxproj') return [{ dimension: 'platform', buildType: '', platform: 'AnyCPU', value: 'x64' }, { dimension: 'platform', buildType: '', platform: 'x86', value: 'Win32' }];
  if (['.shproj', '.vcxitems', '.exe', '.esproj', '.njsproj', '.deployproj', '.vsproj', '.wixproj', '.sqlproj', '.usqldbproj', '.usqlproj', '.sfproj', '.ccproj', '.dcproj'].includes(ext)) return null;
  return [];
}

const applies = (rule, bt, pl) => (!rule.buildType || same(rule.buildType, bt)) && (!rule.platform || samePlatform(rule.platform, pl));
const cellValue = (rule, bt, pl) => {
  if (rule.dimension === 'build' || rule.dimension === 'deploy') return /^true$/i.test(rule.value);
  return rule.value === '*' ? (rule.dimension === 'buildType' ? bt : pl) : rule.value;
};
function applyRules(solution, cells, rules) {
  for (const rule of rules) {
    for (const bt of solution.buildTypes) for (const pl of solution.platforms) {
      if (applies(rule, bt, pl)) cells.set(key(bt, pl), { ...cells.get(key(bt, pl)), [rule.dimension]: cellValue(rule, bt, pl) });
    }
  }
}
const key = (bt, pl) => `${bt.toLowerCase()}|${canonical(pl).toLowerCase()}`;

/** What a project maps to with no rules of its own (SolutionToProjectMappings' expected matrix). */
function expected(solution, project) {
  const cells = new Map();
  for (const bt of solution.buildTypes) for (const pl of solution.platforms) cells.set(key(bt, pl), { buildType: bt, platform: canonical(pl), build: true, deploy: false });
  applyRules(solution, cells, typeRules(project.file) || []);
  return cells;
}

/** The solution's model: its file, format, build types and platforms in their order, and each configurable project with
 *  its cells (key(buildType, platform) -> { buildType, platform, build, deploy }). */
function read(file) {
  const text = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  if (/\.slnx$/i.test(file)) {
    const configurations = /<Configurations>([\s\S]*?)<\/Configurations>/.exec(text)?.[1] || '';
    const names = (tag) => [...configurations.matchAll(new RegExp(`<${tag}\\s+Name="([^"]+)"`, 'g'))].map((m) => unxml(m[1]));
    const solution = { file, format: 'slnx', text, buildTypes: names('BuildType'), platforms: names('Platform'), projects: [] };
    if (!solution.buildTypes.length) solution.buildTypes = ['Debug', 'Release'];
    if (!solution.platforms.length) solution.platforms = ['Any CPU'];
    for (const [, rel, body = ''] of text.matchAll(/<Project\s+Path="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/Project>)/g)) {
      const project = { path: unxml(rel), file: path.resolve(dir, unxml(rel).replace(/[\\/]/g, path.sep)) };
      const own = [];
      for (const dimension of ['buildType', 'platform', 'build', 'deploy']) {
        for (const [element] of body.matchAll(new RegExp(`<${TAGS[dimension]}\\b[^>]*?/?>`, 'g'))) {
          const attr = (n) => { const v = new RegExp(`\\b${n}="([^"]*)"`).exec(element)?.[1]; return v === undefined ? undefined : unxml(v); };
          const [bt = '', pl = ''] = (attr('Solution') || '').split('|');
          own.push({ dimension, buildType: bt === '*' ? '' : bt, platform: pl === '*' ? '' : pl,
            value: attr('Project') ?? (dimension === 'build' || dimension === 'deploy' ? 'true' : '*') });
        }
      }
      if (!typeRules(project.file) && !own.length) continue;
      project.cells = expected(solution, project);
      // Rules naming a build type or platform the solution does not have are skipped, as the library skips them.
      applyRules(solution, project.cells, own.filter((r) => (!r.buildType || indexOf(solution.buildTypes, r.buildType) >= 0) &&
        (!r.platform || indexOf(solution.platforms, r.platform, samePlatform) >= 0)));
      solution.projects.push(project);
    }
    return solution;
  }
  const section = (name) => new RegExp(`GlobalSection\\(${name}\\)[^\\r\\n]*\\r?\\n([\\s\\S]*?)\\s*EndGlobalSection`).exec(text)?.[1] || '';
  const solution = { file, format: 'sln', text, buildTypes: [], platforms: [], projects: [] };
  for (const [, bt, pl] of section('SolutionConfigurationPlatforms').matchAll(/^\s*([^|=\r\n]+)\|([^=\r\n]+?)\s*=/gm)) {
    if (indexOf(solution.buildTypes, bt.trim()) < 0) solution.buildTypes.push(bt.trim());
    if (indexOf(solution.platforms, pl.trim()) < 0) solution.platforms.push(pl.trim());
  }
  const lines = section('ProjectConfigurationPlatforms');
  for (const [, type, name, rel, guid] of text.matchAll(/^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]*)",\s*"([^"]+)",\s*"\{([^}]+)\}"/gm)) {
    if (same(type, FOLDER)) continue;
    const project = { path: rel, name, guid, file: path.resolve(dir, rel.replace(/[\\/]/g, path.sep)) };
    const esc = guid.replace(/-/g, '\\-');
    if (!typeRules(project.file) && !new RegExp(`\\{${esc}\\}\\.`, 'i').test(lines)) continue;
    project.cells = expected(solution, project);
    for (const bt of solution.buildTypes) for (const pl of solution.platforms) {
      const line = (suffix) => new RegExp(`^\\s*\\{${esc}\\}\\.${escape(bt)}\\|${escape(pl)}\\.${suffix}\\s*=\\s*([^\\r\\n]*)`, 'im').exec(lines)?.[1].trim();
      const active = line('ActiveCfg');
      if (active === undefined) continue;
      const [pbt, ppl = '?'] = active.split('|');
      project.cells.set(key(bt, pl), { buildType: pbt, platform: canonical(ppl), build: line('Build\\.0') !== undefined, deploy: line('Deploy\\.0') !== undefined });
    }
    solution.projects.push(project);
  }
  if (!solution.buildTypes.length) solution.buildTypes = ['Debug', 'Release'];
  if (!solution.platforms.length) solution.platforms = ['Any CPU'];
  return solution;
}
const ordinalIgnoreCase = (a, b) => { const x = a.toUpperCase(); const y = b.toUpperCase(); return x < y ? -1 : x > y ? 1 : 0; };
const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unxml = (v) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One dimension's differences from the expected values (DimensionDiffTracker). */
class Tracker {
  constructor() { this.clear(); }
  clear() { this.checked = 0; this.differences = 0; this.first = undefined; this.anyDifferent = false; }
  different(v) { this.checked++; this.differences++; if (this.differences === 1) this.first = v; else this.anyDifferent ||= this.first !== v; }
  observe(e, c) { if (e !== c) this.different(c); else this.checked++; }
  get has() { return this.differences > 0; }
  get same() { return !this.anyDifferent && this.checked === this.differences && this.checked > 0; }
  sameAs(alternate) { return this.same ? { value: this.first } : this.has && alternate?.same ? { value: alternate.first } : undefined; }
}
const trackers = () => Object.fromEntries(DIMENSIONS.map((d) => [d, new Tracker()]));
const comparable = (cell, d) => (d === 'platform' ? canonical(cell.platform) : cell[d]);
const observe = (t, e, c) => { for (const d of DIMENSIONS) t[d].observe(comparable(e, d), comparable(c, d)); };
const hasDifferences = (t) => DIMENSIONS.some((d) => t[d].has);
const hasSame = (t) => DIMENSIONS.some((d) => t[d].same);
const sameCell = (a, b) => a.build === b.build && a.deploy === b.deploy && a.buildType === b.buildType && canonical(a.platform) === canonical(b.platform);

/** A project's rules: the fewest that make the expected matrix its own (SolutionConfigurationMap.CreateRules). */
function rulesOf(solution, project) {
  const exp = expected(solution, project);
  const cur = project.cells;
  const { buildTypes, platforms } = solution;
  const perPlatform = platforms.map(trackers);
  let perBuildType = buildTypes.map(trackers);
  const global = trackers();
  const unique = trackers();
  const rules = [];
  const scoped = (bt, pl, list) => {
    const cells = new Map(exp);
    applyRules({ buildTypes: bt ? [bt] : buildTypes, platforms: pl ? [pl] : platforms }, cells, list);
    for (const [k, v] of cells) exp.set(k, v);
  };
  for (const bt of buildTypes) for (const [i, pl] of platforms.entries()) {
    const e = exp.get(key(bt, pl));
    const c = cur.get(key(bt, pl));
    observe(perPlatform[i], e, c);
    observe(perBuildType[buildTypes.indexOf(bt)], e, c);
    observe(global, e, c);
    for (const d of DIMENSIONS) unique[d].different(comparable(c, d));
  }
  const globalRules = [];
  for (const d of DIMENSIONS) {
    const found = global[d].sameAs(unique[d]);
    if (!found) continue;
    globalRules.push({ dimension: d, buildType: '', platform: '', value: String(found.value) });
    global[d].clear();
    for (const t of [...perBuildType, ...perPlatform]) t[d].clear();
  }
  if (globalRules.length) scoped('', '', globalRules);
  rules.push(...globalRules);
  if (!hasDifferences(global)) return rules;

  const dimensionRules = (t, bt, pl) => {
    const list = [];
    for (const d of DIMENSIONS) {
      const found = t[d].sameAs();
      if (!found) continue;
      list.push({ dimension: d, buildType: bt, platform: pl, value: String(found.value) });
      t[d].clear();
    }
    if (list.length) scoped(bt, pl, list);
    return list;
  };
  let added = false;
  for (const [i, pl] of platforms.entries()) {
    if (!hasSame(perPlatform[i])) continue;
    added = true;
    rules.push(...dimensionRules(perPlatform[i], '', pl));
  }
  if (added) {
    perBuildType = buildTypes.map(trackers);
    for (const [i, bt] of buildTypes.entries()) for (const pl of platforms) observe(perBuildType[i], exp.get(key(bt, pl)), cur.get(key(bt, pl)));
  }
  let singles = false;
  for (const [i, bt] of buildTypes.entries()) {
    if (hasSame(perBuildType[i])) rules.push(...dimensionRules(perBuildType[i], bt, ''));
    singles ||= hasDifferences(perBuildType[i]);
  }
  if (!singles) return rules;
  for (const bt of buildTypes) for (const pl of platforms) {
    const e = exp.get(key(bt, pl));
    const c = cur.get(key(bt, pl));
    if (sameCell(e, c)) continue;
    const list = [];
    if (c.buildType !== e.buildType) list.push({ dimension: 'buildType', buildType: bt, platform: pl, value: c.buildType });
    if (canonical(c.platform) !== canonical(e.platform)) list.push({ dimension: 'platform', buildType: bt, platform: pl, value: c.platform });
    if (c.build !== e.build) list.push({ dimension: 'build', buildType: bt, platform: pl, value: String(c.build) });
    if (c.deploy !== e.deploy) list.push({ dimension: 'deploy', buildType: bt, platform: pl, value: String(c.deploy) });
    if (list.length) scoped(bt, pl, list);
    rules.push(...list);
  }
  return rules;
}

/** The solution's text with its configurations written as VS writes them, everything else as it was. */
function write(solution) {
  const { text } = solution;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (solution.format === 'slnx') {
    const unit = /\n([ \t]+)</.exec(text)?.[1] || '  ';
    let next = text;
    // <Configurations>: left out while it is the default (Debug and Release, Any CPU), as the library leaves it out.
    const implicitTypes = solution.buildTypes.length === 2 && indexOf(solution.buildTypes, 'Debug', (a, b) => a === b) >= 0 && indexOf(solution.buildTypes, 'Release', (a, b) => a === b) >= 0;
    const implicitPlatforms = solution.platforms.length === 1 && solution.platforms[0] === 'Any CPU';
    const own = /([ \t]*)<ProjectType\b[^>]*\/>/g;
    const projectTypes = (/<Configurations>([\s\S]*?)<\/Configurations>/.exec(text)?.[1] || '').match(own) || [];
    const lines = [...(implicitTypes ? [] : solution.buildTypes.map((n) => `<BuildType Name="${xml(n)}" />`)),
      ...(implicitPlatforms ? [] : solution.platforms.map((n) => `<Platform Name="${xml(n)}" />`)), ...projectTypes.map((l) => l.trim())];
    const block = lines.length ? `${unit}<Configurations>${eol}${lines.map((l) => `${unit}${unit}${l}${eol}`).join('')}${unit}</Configurations>${eol}` : '';
    if (/[ \t]*<Configurations>[\s\S]*?<\/Configurations>[^\S\r\n]*\r?\n/.test(next)) next = next.replace(/[ \t]*<Configurations>[\s\S]*?<\/Configurations>[^\S\r\n]*\r?\n/, () => block);
    else if (block) next = next.replace(/(<Solution\b[^>]*>[^\S\r\n]*\r?\n)/, (m) => m + block);
    next = next.replace(/([ \t]*)<Project\s+Path="([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/Project>)/g, (whole, indent, rel, attrs, body) => {
      const project = solution.projects.find((p) => p.path === unxml(rel));
      if (!project) return whole;
      const ref = (r) => (r.buildType || r.platform ? `${r.buildType || '*'}|${r.platform || '*'}` : '');
      const element = (r) => {
        const solutionRef = ref(r) ? ` Solution="${xml(ref(r))}"` : '';
        if (r.dimension === 'build' || r.dimension === 'deploy') return `<${TAGS[r.dimension]}${solutionRef}${r.value === 'true' ? '' : ' Project="false"'} />`;
        return `<${TAGS[r.dimension]}${solutionRef} Project="${xml(r.value)}" />`;
      };
      const rules = rulesOf(solution, project);
      const lines = ['buildType', 'platform', 'build', 'deploy'].flatMap((d) => rules.filter((r) => r.dimension === d)
        .sort((a, b) => ordinalIgnoreCase(ref(a), ref(b)))).map((r) => `${indent}${unit}${element(r)}${eol}`);
      // The rules go where the old ones were, the project's other children (BuildDependency, Properties) staying put.
      const kept = [];
      let at = -1;
      for (const part of (body ?? `${eol}${indent}`).split(/(?<=\n)/)) {
        if (/^[ \t]*<(BuildType|Platform|Build|Deploy)\b[^>]*\/>\s*$/.test(part)) at = at < 0 ? kept.length : at;
        else kept.push(part);
      }
      kept.splice(at < 0 ? kept.length - 1 : at, 0, ...lines);
      const open = `${indent}<Project Path="${rel}"${attrs.replace(/\s+$/, '')}`;
      return kept.join('').trim() ? `${open}>${kept.join('')}</Project>` : `${open} />`;
    });
    return next;
  }
  const slnPlatform = (p) => (p === 'AnyCPU' ? 'Any CPU' : p);
  const configs = solution.buildTypes.flatMap((bt) => solution.platforms.map((pl) => `${bt}|${pl}`));
  const solutionLines = configs.map((c) => `\t\t${c} = ${c}${eol}`).join('');
  const projectLines = solution.projects.filter((p) => p.guid).flatMap((p) => solution.buildTypes.flatMap((bt) => solution.platforms.flatMap((pl) => {
    const c = p.cells.get(key(bt, pl));
    if (!c || c.platform === '?') return [];
    const value = `${c.buildType}|${slnPlatform(c.platform)}`;
    const id = `\t\t{${p.guid}}.${bt}|${pl}`;
    return [`${id}.ActiveCfg = ${value}${eol}`, ...(c.build ? [`${id}.Build.0 = ${value}${eol}`] : []), ...(c.deploy ? [`${id}.Deploy.0 = ${value}${eol}`] : [])];
  }))).join('');
  const setSection = (t, name, when, lines) => {
    const re = new RegExp(`(\\tGlobalSection\\(${name}\\) = \\w+\\r?\\n)[\\s\\S]*?(\\tEndGlobalSection)`);
    if (re.test(t)) return t.replace(re, (m, open, close) => open + lines + close);
    return t.replace(/^Global\r?\n/m, (m) => `${m}\tGlobalSection(${name}) = ${when}${eol}${lines}\tEndGlobalSection${eol}`);
  };
  let next = setSection(text, 'ProjectConfigurationPlatforms', 'postSolution', projectLines);
  next = setSection(next, 'SolutionConfigurationPlatforms', 'preSolution', solutionLines);
  return next;
}

/** Where VS puts a new name: before the first one after it (ordinal, ignoring case) among those already there. */
function insertSorted(list, name) {
  const at = list.findIndex((x) => ordinalIgnoreCase(x, name) > 0);
  list.splice(at < 0 ? list.length : at, 0, name);
}

/** A new solution build type or platform (kind 'buildTypes' or 'platforms'): each project's cells copied from those of
 *  `from` (none: the defaults), then changed by `pick(project, copied)`. */
function addSolution(solution, kind, name, from, pick = () => ({})) {
  insertSorted(solution[kind], name);
  const other = kind === 'buildTypes' ? solution.platforms : solution.buildTypes;
  for (const project of solution.projects) {
    for (const o of other) {
      const [bt, pl] = kind === 'buildTypes' ? [name, o] : [o, name];
      const source = from && project.cells.get(kind === 'buildTypes' ? key(from, o) : key(o, from));
      const base = { ...expected({ buildTypes: [bt], platforms: [pl] }, project).get(key(bt, pl)), ...source };
      project.cells.set(key(bt, pl), { ...base, ...pick(project, base) });
    }
  }
}
const part = (kind) => (kind === 'buildTypes' ? 0 : 1);
const keyPart = (kind, name) => (kind === 'buildTypes' ? name : canonical(name)).toLowerCase();
function removeSolution(solution, kind, name) {
  const at = indexOf(solution[kind], name);
  if (at < 0) return;
  solution[kind].splice(at, 1);
  for (const project of solution.projects) for (const k of [...project.cells.keys()]) if (k.split('|')[part(kind)] === keyPart(kind, name)) project.cells.delete(k);
}
function renameSolution(solution, kind, from, to) {
  const at = indexOf(solution[kind], from);
  if (at < 0) return;
  solution[kind][at] = to;
  for (const project of solution.projects) {
    project.cells = new Map([...project.cells].map(([k, v]) => {
      const parts = k.split('|');
      if (parts[part(kind)] === keyPart(kind, from)) parts[part(kind)] = keyPart(kind, to);
      return [parts.join('|'), v];
    }));
  }
}
/** A project's build type or platform renamed to `to` in every cell that maps to it. */
function renameProject(project, dimension, from, to) {
  for (const [k, v] of project.cells) {
    if (dimension === 'platform' ? samePlatform(v.platform, from) : v.buildType === from) project.cells.set(k, { ...v, [dimension]: to });
  }
}

/** The PropertyGroups conditioned on one project configuration or platform ('$(Configuration)|$(Platform)'=='Debug|AnyCPU',
 *  '$(Configuration)'=='Debug'), for `to`: copied after each of them (mode 'copy') or renamed in place. */
function conditionedGroups(text, dimension, from, to, mode) {
  const variable = dimension === 'platform' ? '$(Platform)' : '$(Configuration)';
  return text.replace(/([ \t]*)<PropertyGroup\s+([^>]*?)Condition="([^"]*)"([^>]*)>([\s\S]*?)<\/PropertyGroup>([^\S\r\n]*\r?\n)?/g, (whole, indent, before, condition, after, body, end = '') => {
    const m = /^\s*'([^']*)'\s*==\s*'([^']*)'\s*$/.exec(condition);
    if (!m) return whole;
    const at = m[1].split('|').map((s) => s.trim()).indexOf(variable);
    const right = m[2].split('|');
    if (at < 0 || !(dimension === 'platform' ? samePlatform(right[at], from) : right[at] === from)) return whole;
    right[at] = dimension === 'platform' ? to.replace(/\s/g, '') : to;
    const changed = `${indent}<PropertyGroup ${before}Condition="${condition.replace(m[2], right.join('|'))}"${after}>${body}</PropertyGroup>${end}`;
    return mode === 'copy' ? whole + changed : changed;
  });
}

module.exports = { read, write, rulesOf, expected, addSolution, removeSolution, renameSolution, renameProject, conditionedGroups, canonical, samePlatform, key };
