// Visual Studio 2026's project Properties window (a project's context menu, Właściwości, or Alt+Enter) in an editor tab:
// its pages from the XAML rules VS ships (property-rules.js), Wyszukaj właściwości over every page, the pages and their
// categories on the left, each property with its description, its editor and, under a value with $(...) in it, what MSBuild
// makes of it; a property shown or hidden as its VisibilityCondition says, and each change written to the project file at
// once, as VS writes it, then read back from MSBuild. Properties that depend on the configuration take the one chosen at
// the top (or all of them).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { table, language } = require('./l10n');
const r = require('./property-rules');

const T = table({
  search: 'Search properties',
  configuration: 'Configuration:',
  platform: 'Platform:',
  allConfigurations: 'All configurations',
  none: '(None)',
  notSet: '(Not set)',
  browse: 'Browse...',
  noMatch: 'No properties match the search.',
  loading: 'Reading the project…',
  perConfiguration: 'Applies to {0}',
  add: 'Add',
  remove: 'Remove',
  namespace: 'Namespace',
  fromSdk: 'from the SDK',
  notFound: '{0} was not found in the project.',
  saveFailed: 'Could not save {0}: {1}',
  evaluateFailed: 'MSBuild could not read {0}: {1}',
});

// The few cultures VS's Neutral language list begins with; any other one typed in the project file is listed too.
const CULTURES = ['en', 'en-US', 'en-GB', 'pl', 'pl-PL', 'de', 'de-DE', 'fr', 'fr-FR', 'es', 'es-ES', 'it', 'it-IT', 'cs', 'cs-CZ', 'ru', 'ru-RU', 'uk', 'uk-UA', 'ja', 'ja-JP', 'zh-Hans', 'zh-Hant'];
const ITEMS = ['SupportedTargetFramework', 'SdkSupportedTargetPlatformIdentifier', 'SdkSupportedTargetPlatformVersion', 'ProjectCapability', 'Using'];

/** The capabilities VS's own Microsoft.Managed.DesignTime.targets adds (imported in VS only, so MSBuild here does not
 *  report them), as its conditions there have them: the pages' conditions ask for some (LaunchProfiles: Debuguj). */
function designTimeCapabilities(p) {
  const yes = (v) => String(v).toLowerCase() === 'true';
  return ['.NET', 'LaunchProfiles', 'ProjectPropertyInterception', 'Publish', 'FolderPublish', 'DependenciesTree', 'UseFileGlobs',
    ...(p.TargetFrameworkIdentifier === '.NETFramework' || yes(p.UseWPF) || yes(p.UseWindowsForms) ? ['AppSettings'] : []),
    ...(yes(p.UseWPF) ? ['WPF'] : []), ...(yes(p.UseWindowsForms) ? ['WindowsForms'] : []), ...(p.OutputType === 'Exe' ? ['AppServicePublish'] : [])];
}

/** One evaluation of the project: the properties asked for and the items the pages list, for a configuration. */
function evaluate(projectFile, names, settings) {
  const args = ['msbuild', projectFile, ...names.map((n) => `-getProperty:${n}`), ...ITEMS.map((i) => `-getItem:${i}`),
    ...(settings ? [`-p:Configuration=${settings.configuration}`, `-p:Platform=${settings.platform}`] : [])];
  return new Promise((resolve, reject) => execFile('dotnet', args, { cwd: path.dirname(projectFile), windowsHide: true, maxBuffer: 32 << 20 }, (error, stdout, stderr) => {
    try {
      const json = JSON.parse(stdout);
      resolve({ properties: json.Properties || {}, items: json.Items || {} });
    } catch {
      reject(new Error((stderr || stdout || error?.message || '').trim().split(/\r?\n/).slice(-3).join(' ')));
    }
  }));
}

/** The page's model: each page, category and visible property with its value, editor and choices. */
function model(pages, projectFile, text, evaluated, settings) {
  const items = (n) => evaluated.items[n] || [];
  const configKey = settings ? `${settings.configuration}|${settings.platform}`.toLowerCase().replace(/\s/g, '') : '';
  const io = (perConfiguration) => ({
    u: (n) => r.readProperty(text, n, perConfiguration ? configKey : ''),
    e: (n) => evaluated.properties[n] ?? '',
    items,
    text,
    project: projectFile,
  });
  const values = new Map();
  for (const page of pages) for (const p of page.properties) values.set(`${page.name}::${p.name}`, r.valueOf(p, io(p.perConfiguration)));
  const ctx = {
    value: (rule, name) => values.get(`${rule}::${name}`)?.e,
    unevaluated: (rule, name) => values.get(`${rule}::${name}`)?.u,
    msbuild: (n) => evaluated.properties[n] ?? '',
    capabilities: new Set([...items('ProjectCapability').map((i) => i.Identity), ...designTimeCapabilities(evaluated.properties)].map((c) => c.toLowerCase())),
  };
  const choices = (p, current) => {
    let list = p.values.map((v) => ({ value: v.value, label: v.label }));
    if (p.enumProvider === 'SupportedTargetFrameworksEnumProvider') list = items('SupportedTargetFramework').map((i) => ({ value: i.Identity, label: i.DisplayName || i.Alias || i.Identity }));
    if (p.enumProvider === 'SdkSupportedTargetPlatformIdentifierEnumProvider') {
      list = [{ value: '', label: T.none }, ...items('SdkSupportedTargetPlatformIdentifier').map((i) => ({ value: i.Identity, label: i.DisplayName || i.Identity }))];
    }
    if (/^SdkSupported(TargetPlatform|OSPlatform)VersionEnumProvider$/.test(p.enumProvider)) {
      list = [{ value: '', label: T.none }, ...items('SdkSupportedTargetPlatformVersion').map((i) => ({ value: i.Identity, label: i.Identity }))];
    }
    if (p.enumProvider === 'PlatformTargetEnumProvider') {
      list = (evaluated.properties.AvailablePlatforms || 'AnyCPU').split(/[;,]/).map((s) => s.trim()).filter(Boolean).map((s) => ({ value: s.replace(/\s/g, ''), label: s }));
    }
    if (p.enumProvider === 'NeutralLanguageEnumProvider') list = [{ value: '', label: T.none }, ...CULTURES.map((c) => ({ value: c, label: c }))];
    if (p.enumProvider === 'StartupObjectsEnumProvider') list = [{ value: '', label: T.notSet }];
    // A value the project has that the list does not offer is listed too, as VS lists it.
    if (current && !list.some((c) => c.value.toLowerCase() === String(current).toLowerCase())) list.push({ value: current, label: current });
    return list;
  };
  const editorOf = (p) => {
    const type = p.editors[0]?.type || '';
    if (type === 'Description') return 'description';
    if (type === 'LinkAction') return 'link';
    if (type === 'CSharpImplicitUsingsEditor') return 'usings';
    if (p.kind === 'BoolProperty') return 'bool';
    if (p.kind === 'EnumProperty' || p.kind === 'DynamicEnumProperty') return 'enum';
    if (type === 'MultiLineString' || type === 'NameValueList') return 'multiline';
    if (type === 'FilePath' || p.subtype === 'file') return 'file';
    return 'string';
  };
  const projectUsings = r.readUsings(text);
  return pages.map((page) => ({
    name: page.name,
    title: page.title,
    categories: page.categories.map((c) => ({
      name: c.name,
      title: c.title,
      properties: page.properties.filter((p) => p.category === c.name && p.visible && r.evaluateCondition(p.metadata.VisibilityCondition, ctx)).map((p) => {
        const v = values.get(`${page.name}::${p.name}`);
        const editor = editorOf(p);
        const shown = v.u !== undefined && v.u !== '' ? v.u : v.e;
        const link = editor === 'link' ? p.editors[0].metadata : undefined;
        return {
          id: `${page.name}::${p.name}`,
          title: p.title,
          description: p.description,
          help: p.helpUrl,
          searchTerms: p.metadata.SearchTerms || '',
          editor,
          value: editor === 'bool' ? String(shown).toLowerCase() === 'true' : shown ?? '',
          inherited: v.u === undefined || v.u === '',
          preview: editor !== 'enum' && editor !== 'bool' && v.u && v.u.includes('$(') && v.e !== v.u ? v.e : '',
          choices: editor === 'enum' ? choices(p, shown) : undefined,
          link: link && { action: link.Action, url: link.URL, command: link.Command },
          perConfiguration: p.perConfiguration,
          readOnly: p.readOnly || (p.metadata.EditabilityCondition ? !r.evaluateCondition(p.metadata.EditabilityCondition, ctx) : false),
          usings: editor === 'usings' ? items('Using').map((i) => ({ name: i.Identity, alias: i.Alias || '', isStatic: /^true$/i.test(i.Static || ''),
            own: projectUsings.some((u) => u.kind === 'Include' && u.name === i.Identity) })) : undefined,
        };
      }),
    })).filter((c) => c.properties.length),
  })).filter((p) => p.categories.length);
}

function registerPropertiesPage(context, solutionView) {
  const pages = new Map(); // project file -> panel
  const rulesDir = context.asAbsolutePath('rules');
  const configurationsOf = (evaluated) => ({
    configurations: (evaluated.properties.Configurations || 'Debug;Release').split(';').map((s) => s.trim()).filter(Boolean),
    platforms: (evaluated.properties.Platforms || 'AnyCPU').split(';').map((s) => s.trim()).filter(Boolean),
  });

  const open = async (item) => {
    const target = item?.file ? item : solutionView?.view.selection[0];
    const projectFile = target?.file;
    if (!projectFile || !/proj$/i.test(projectFile)) return undefined;
    const existing = pages.get(projectFile);
    if (existing) {
      existing.reveal();
      return existing;
    }
    const name = path.basename(projectFile, path.extname(projectFile));
    const panel = vscode.window.createWebviewPanel('csharpShooter.properties', name, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = new vscode.ThemeIcon('settings-gear');
    pages.set(projectFile, panel);
    panel.onDidDispose(() => pages.delete(projectFile));
    const post = (m) => panel.webview.postMessage(m);
    const rules = r.loadPages(rulesDir, language());
    const names = r.evaluatedNames(rules);
    // The configuration the page shows the configuration-dependent properties for: Debug and the first platform at first.
    let settings = { configuration: 'Debug', platform: 'AnyCPU' };
    let scope = 'one'; // or 'all': All configurations, where a change goes to the project's unconditional properties
    panel.state = { model: undefined, settings, scope };

    const show = async () => {
      const text = fs.readFileSync(projectFile, 'utf8');
      let evaluated;
      try {
        evaluated = await evaluate(projectFile, names, scope === 'all' ? undefined : settings);
      } catch (e) {
        post({ type: 'error', text: T.evaluateFailed(name, e.message) });
        return;
      }
      const choices = configurationsOf(evaluated);
      if (!choices.configurations.includes(settings.configuration)) settings.configuration = choices.configurations[0];
      if (!choices.platforms.map((p) => p.replace(/\s/g, '')).includes(settings.platform.replace(/\s/g, ''))) settings.platform = choices.platforms[0].replace(/\s/g, '');
      const pagesModel = model(rules, projectFile, text, evaluated, scope === 'all' ? undefined : settings);
      panel.state = { model: pagesModel, settings: { ...settings }, scope, evaluated };
      post({ type: 'show', pages: pagesModel, settings, scope, ...choices, appliesTo: scope === 'all' ? T.allConfigurations : `${settings.configuration} | ${settings.platform}` });
    };

    const find = (id) => {
      const [pageName, propName] = id.split('::');
      const page = rules.find((p) => p.name === pageName);
      return page && { page, prop: page.properties.find((p) => p.name === propName) };
    };
    const save = async (next) => {
      const text = fs.readFileSync(projectFile, 'utf8');
      if (next === text) return;
      try {
        fs.writeFileSync(projectFile, next);
      } catch (e) {
        vscode.window.showErrorMessage(T.saveFailed(path.basename(projectFile), e.message));
      }
    };

    const request = (panel.request = async (m) => {
      if (m.type === 'ready') await show();
      if (m.type === 'settings') {
        scope = m.scope || scope;
        settings = { configuration: m.configuration || settings.configuration, platform: m.platform || settings.platform };
        await show();
      }
      if (m.type === 'set') {
        const found = find(m.id);
        if (!found?.prop) return;
        const text = fs.readFileSync(projectFile, 'utf8');
        const perConfiguration = found.prop.perConfiguration && scope !== 'all';
        const configKey = perConfiguration ? `${settings.configuration}|${settings.platform}`.toLowerCase().replace(/\s/g, '') : '';
        const io = {
          u: (n) => r.readProperty(text, n, configKey),
          e: (n) => panel.state.evaluated?.properties[n] ?? '',
          items: (n) => panel.state.evaluated?.items[n] || [],
          text,
          project: projectFile,
        };
        const value = typeof m.value === 'boolean' ? String(m.value) : String(m.value ?? '');
        await save(r.applyWrites(text, r.writesFor(found.prop, io, value), configKey, perConfiguration ? r.configCondition(settings.configuration, settings.platform) : ''));
        await show();
      }
      if (m.type === 'using') {
        const text = fs.readFileSync(projectFile, 'utf8');
        const own = r.readUsings(text).some((u) => u.kind === 'Include' && u.name === m.name);
        const next = m.op === 'add' ? r.writeUsing(r.writeUsing(text, 'Remove', m.name, false), 'Include', m.name, true)
          : own ? r.writeUsing(text, 'Include', m.name, false) : r.writeUsing(text, 'Remove', m.name, true);
        await save(next);
        await show();
      }
      if (m.type === 'browse') {
        const [file] = (await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: vscode.Uri.file(path.dirname(projectFile)) })) || [];
        if (file) await request({ type: 'set', id: m.id, value: path.relative(path.dirname(projectFile), file.fsPath) });
      }
      if (m.type === 'help' && m.url) await vscode.env.openExternal(vscode.Uri.parse(m.url));
      if (m.type === 'link') {
        if (m.link.action === 'URL' && m.link.url) await vscode.env.openExternal(vscode.Uri.parse(m.link.url));
        // VS's editors for these: the file they edit, opened here when the project has it.
        const files = { OpenLaunchProfilesEditor: 'Properties/launchSettings.json', CreateOrOpenAssemblyResources: 'Properties/Resources.resx',
          CreateOrOpenApplicationSettings: 'Properties/Settings.settings', CreateOrOpenAppManifest: 'app.manifest' };
        const rel = files[m.link.command];
        if (rel) {
          const file = path.join(path.dirname(projectFile), rel);
          if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file));
          else vscode.window.showInformationMessage(T.notFound(rel));
        }
      }
    });
    panel.webview.onDidReceiveMessage((m) => request(m).catch((e) => post({ type: 'error', text: e.message })));
    panel.webview.html = html();
    return panel;
  };

  context.subscriptions.push(vscode.commands.registerCommand('csharpShooter.solution.properties', open));

  function html() {
    const nonce = String(Math.random()).slice(2);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const texts = { search: T.search, configuration: T.configuration, platform: T.platform, allConfigurations: T.allConfigurations, browse: T.browse,
      noMatch: T.noMatch, perConfiguration: T.perConfiguration('{0}'), add: T.add, remove: T.remove, namespace: T.namespace, fromSdk: T.fromSdk };
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --muted: var(--vscode-descriptionForeground); }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  #search { flex: 1; font: inherit; padding: 5px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  #search:focus { outline: 1px solid var(--vscode-focusBorder); }
  header label { color: var(--muted); display: flex; gap: 6px; align-items: center; white-space: nowrap; }
  select, input[type=text], textarea { font: inherit; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border-color: var(--vscode-dropdown-border, var(--line)); }
  .wrap { flex: 1; min-height: 0; display: flex; }
  nav { width: 200px; flex-shrink: 0; overflow: auto; padding: 8px 0; border-right: 1px solid var(--line); }
  nav .page { padding: 3px 10px; cursor: pointer; display: flex; gap: 4px; }
  nav .page::before { content: '▸'; width: 12px; color: var(--muted); }
  nav .page.open::before { content: '▾'; }
  nav .cat { padding: 2px 10px 2px 30px; cursor: pointer; }
  nav .page:hover, nav .cat:hover { background: var(--vscode-list-hoverBackground); }
  nav .cat.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); font-weight: 600; }
  main { flex: 1; min-width: 0; overflow: auto; padding: 0 28px 40px; }
  h1 { font-size: 1.6em; font-weight: 400; margin: 18px 0 10px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .category { display: grid; grid-template-columns: 160px 1fr; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--line); }
  .category > h2 { font-size: 1.15em; font-weight: 400; margin: 0; }
  .prop { margin-bottom: 18px; max-width: 640px; }
  .prop .t { font-weight: 600; display: flex; gap: 6px; align-items: center; }
  .prop .help { color: var(--vscode-textLink-foreground); cursor: pointer; border: 1px solid currentColor; border-radius: 50%; width: 14px; height: 14px; font-size: 10px; display: inline-flex; align-items: center; justify-content: center; }
  .prop .cfg { font-weight: 400; font-size: .85em; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; }
  .prop .d { color: var(--muted); margin: 2px 0 6px; }
  .prop input[type=text], .prop select { width: 280px; }
  .prop textarea { width: 100%; min-height: 56px; font-family: var(--vscode-editor-font-family); }
  .prop .inherited { color: var(--muted); }
  .preview { margin-top: 6px; padding-left: 8px; border-left: 2px solid var(--vscode-textLink-foreground); color: var(--muted); }
  .prop a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .row { display: flex; gap: 6px; align-items: center; }
  button { font: inherit; padding: 3px 12px; cursor: pointer; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .usings { border: 1px solid var(--line); max-height: 220px; overflow: auto; margin-bottom: 6px; }
  .usings div { display: flex; justify-content: space-between; padding: 2px 8px; font-family: var(--vscode-editor-font-family); }
  .usings div:hover { background: var(--vscode-list-hoverBackground); }
  .usings .sdk { color: var(--muted); }
  mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; }
  .message { padding: 24px 0; color: var(--muted); }
  .error { color: var(--vscode-errorForeground); padding: 10px 0; }
</style></head><body>
<header>
  <input id="search" placeholder="${esc(T.search)}" aria-label="${esc(T.search)}" spellcheck="false">
  <label>${esc(T.configuration)} <select id="configuration"></select></label>
  <label>${esc(T.platform)} <select id="platform"></select></label>
</header>
<div class="wrap"><nav id="nav"></nav><main id="main"><div class="message">${esc(T.loading)}</div></main></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const T = ${JSON.stringify(texts)};
  const $ = (id) => document.getElementById(id);
  let pages = [], openPage = '', current = '';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const highlight = (s, q) => {
    if (!q) return esc(s);
    const at = s.toLowerCase().indexOf(q);
    return at < 0 ? esc(s) : esc(s.slice(0, at)) + '<mark>' + esc(s.slice(at, at + q.length)) + '</mark>' + esc(s.slice(at + q.length));
  };
  const matches = (p, q) => !q || [p.title, p.description, p.searchTerms, p.id.split('::')[1]].some((s) => String(s).toLowerCase().includes(q));
  const editor = (p) => {
    const id = esc(p.id), ro = p.readOnly ? ' disabled' : '';
    if (p.editor === 'description') return '';
    if (p.editor === 'link') return '<a data-link="' + id + '">' + esc(p.title) + '</a>';
    if (p.editor === 'bool') return '<label class="row"><input type="checkbox" data-id="' + id + '"' + (p.value ? ' checked' : '') + ro + '></label>';
    if (p.editor === 'enum') return '<select data-id="' + id + '"' + ro + '>' + p.choices.map((c) => '<option value="' + esc(c.value) + '"' +
      (String(c.value).toLowerCase() === String(p.value).toLowerCase() ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</select>';
    if (p.editor === 'multiline') return '<textarea data-id="' + id + '" spellcheck="false"' + ro + (p.inherited ? ' class="inherited"' : '') + '>' + esc(p.value) + '</textarea>';
    if (p.editor === 'usings') return '<div class="usings">' + (p.usings || []).map((u) => '<div class="' + (u.own ? '' : 'sdk') + '"><span>' +
      (u.isStatic ? 'static ' : '') + esc(u.alias ? u.alias + ' = ' + u.name : u.name) + (u.own ? '' : ' (' + esc(T.fromSdk) + ')') + '</span><a data-unusing="' + esc(u.name) + '">' + esc(T.remove) + '</a></div>').join('') +
      '</div><div class="row"><input type="text" id="newUsing" placeholder="' + esc(T.namespace) + '" spellcheck="false"><button id="addUsing">' + esc(T.add) + '</button></div>';
    const box = '<input type="text" data-id="' + id + '" value="' + esc(p.value) + '" spellcheck="false"' + ro + (p.inherited ? ' class="inherited"' : '') + '>';
    return p.editor === 'file' ? '<div class="row">' + box + '<button data-browse="' + id + '">' + esc(T.browse) + '</button></div>' : box;
  };
  const render = () => {
    const q = $('search').value.trim().toLowerCase();
    let html = '', navHtml = '', any = false;
    for (const page of pages) {
      const cats = page.categories.map((c) => ({ ...c, properties: c.properties.filter((p) => matches(p, q)) })).filter((c) => c.properties.length);
      if (!cats.length) continue;
      any = true;
      const isOpen = q || openPage === page.name;
      navHtml += '<div class="page' + (isOpen ? ' open' : '') + '" data-page="' + esc(page.name) + '">' + esc(page.title) + '</div>';
      if (isOpen) for (const c of cats) navHtml += '<div class="cat' + (current === page.name + '/' + c.name ? ' sel' : '') + '" data-cat="' + esc(page.name + '/' + c.name) + '">' + esc(c.title) + '</div>';
      html += '<h1 id="page-' + esc(page.name) + '">' + esc(page.title) + '</h1>';
      for (const c of cats) {
        html += '<section class="category" id="cat-' + esc(page.name + '/' + c.name) + '"><h2>' + esc(c.title) + '</h2><div>';
        for (const p of c.properties) {
          html += '<div class="prop">' + (p.editor === 'link' ? '' : '<div class="t">' + highlight(p.title, q) +
            (p.help ? '<span class="help" data-help="' + esc(p.help) + '" title="' + esc(p.help) + '">?</span>' : '') +
            (p.perConfiguration ? '<span class="cfg" title="' + esc(T.perConfiguration.replace('{0}', state.appliesTo)) + '">' + esc(state.appliesTo) + '</span>' : '') + '</div>') +
            (p.description ? '<div class="d">' + highlight(p.description, q) + '</div>' : '') + editor(p) +
            (p.preview ? '<div class="preview">' + esc(p.preview) + '</div>' : '') + '</div>';
        }
        html += '</div></section>';
      }
    }
    $('nav').innerHTML = navHtml;
    $('main').innerHTML = any ? html : '<div class="message">' + esc(T.noMatch) + '</div>';
  };
  let state = { appliesTo: '' };
  const send = (m) => vscode.postMessage(m);
  $('search').addEventListener('input', render);
  $('configuration').onchange = () => {
    const v = $('configuration').value;
    send(v === '*' ? { type: 'settings', scope: 'all' } : { type: 'settings', scope: 'one', configuration: v });
  };
  $('platform').onchange = () => send({ type: 'settings', scope: 'one', platform: $('platform').value });
  document.addEventListener('change', (e) => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id) return;
    send({ type: 'set', id, value: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-page],[data-cat],[data-help],[data-link],[data-browse],[data-unusing],#addUsing');
    if (!t) return;
    if (t.dataset.page) { openPage = t.dataset.page; render(); const h = document.getElementById('page-' + t.dataset.page); if (h) h.scrollIntoView(); }
    else if (t.dataset.cat) { current = t.dataset.cat; render(); const s = document.getElementById('cat-' + t.dataset.cat); if (s) s.scrollIntoView(); }
    else if (t.dataset.help) send({ type: 'help', url: t.dataset.help });
    else if (t.dataset.link) { const p = pages.flatMap((x) => x.categories.flatMap((c) => c.properties)).find((x) => x.id === t.dataset.link); if (p) send({ type: 'link', link: p.link }); }
    else if (t.dataset.browse) send({ type: 'browse', id: t.dataset.browse });
    else if (t.dataset.unusing) send({ type: 'using', op: 'remove', name: t.dataset.unusing });
    else if (t.id === 'addUsing' && $('newUsing').value.trim()) send({ type: 'using', op: 'add', name: $('newUsing').value.trim() });
  });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'show') {
      pages = m.pages;
      state = m;
      if (!openPage && pages[0]) { openPage = pages[0].name; current = pages[0].name + '/' + (pages[0].categories[0] || {}).name; }
      $('configuration').innerHTML = m.configurations.map((c) => '<option value="' + esc(c) + '"' + (m.scope !== 'all' && c === m.settings.configuration ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
        '<option value="*"' + (m.scope === 'all' ? ' selected' : '') + '>' + esc(T.allConfigurations) + '</option>';
      $('platform').innerHTML = m.platforms.map((p) => '<option value="' + esc(p.split(' ').join('')) + '"' + (p.split(' ').join('') === m.settings.platform ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
      $('platform').disabled = m.scope === 'all';
      const keep = $('main').scrollTop;
      render();
      $('main').scrollTop = keep;
    }
    if (m.type === 'error') $('main').insertAdjacentHTML('afterbegin', '<div class="error">' + esc(m.text) + '</div>');
    if (m.type === 'search') { $('search').value = m.text; render(); }
  });
  send({ type: 'ready' });
</script></body></html>`;
  }

  return { open, pages, model, evaluate };
}

module.exports = { registerPropertiesPage };
