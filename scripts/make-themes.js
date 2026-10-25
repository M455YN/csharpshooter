// Writes themes/visual-studio-2026-{dark,light}-color-theme.json from Visual Studio 2026's own themes: the shell's colours
// from Theme.Dark/Theme.Light.pkgdef, the editor's from EditorColors.pkgdef (Dark's; Light's editor is VS's built-in
// defaults, which that file leaves out, written here as VS shows them). Run it where VS 2026 is installed:
//   node scripts/make-themes.js ["C:\Program Files\Microsoft Visual Studio\18\Community"]
const fs = require('fs');
const path = require('path');
const { readTheme } = require('./vs-theme');

const vs = process.argv[2] || 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community';
const platform = path.join(vs, 'Common7', 'IDE', 'CommonExtensions', 'Platform');
const DARK = '1ded0138-47ce-435e-84ef-9ec1f439b749';

// The editor's colours by VS's classification names: Dark's from EditorColors.pkgdef; Roslyn's own (class name, local
// name…) are VS's defaults for each theme, as its Fonts and Colors shows them.
const roslyn = {
  dark: { class: '#4EC9B0', struct: '#86C691', interface: '#B8D7A3', enum: '#B8D7A3', typeParameter: '#B8D7A3', delegate: '#4EC9B0', method: '#DCDCAA',
    parameter: '#9CDCFE', variable: '#9CDCFE', property: '#DCDCDC', field: '#DCDCDC', enumMember: '#DCDCDC', namespace: '#DCDCDC', controlKeyword: '#D8A0DF',
    regex: '#D69D85', punctuation: '#DCDCDC', label: '#C8C8C8', operatorOverloaded: '#DCDCAA' },
  light: { class: '#2B91AF', struct: '#2B91AF', interface: '#2B91AF', enum: '#2B91AF', typeParameter: '#2B91AF', delegate: '#2B91AF', method: '#74531F',
    parameter: '#1F377F', variable: '#1F377F', property: '#000000', field: '#000000', enumMember: '#000000', namespace: '#000000', controlKeyword: '#8F08C4',
    regex: '#800000', punctuation: '#000000', label: '#000000', operatorOverloaded: '#74531F' },
};

function editorOf(kind) {
  if (kind === 'light') {
    return { background: '#FFFFFF', foreground: '#000000', selection: '#ADD6FF', inactiveSelection: '#E5EBF1', lineNumber: '#2B91AF', activeLineNumber: '#000000',
      keyword: '#0000FF', comment: '#008000', string: '#A31515', number: '#000000', operator: '#000000', preprocessor: '#808080', type: '#2B91AF',
      escape: '#B776FB', htmlElement: '#800000', htmlAttribute: '#FF0000', htmlValue: '#0000FF', htmlDelimiter: '#0000FF', razor: '#F3F3F3', xmlDoc: '#808080' };
  }
  const t = readTheme(path.join(platform, 'EditorColors.pkgdef'), DARK);
  const text = t['Text Editor Text Manager Items'];
  const mef = t['Text Editor MEF Items'];
  const fg = (name, fallback) => mef[name]?.fg || fallback;
  return { background: text['Plain Text'].bg, foreground: text['Plain Text'].fg, selection: mef['Selected Text']?.bg || text['Selected Text'].bg,
    inactiveSelection: mef['Inactive Selected Text']?.bg || text['Inactive Selected Text'].bg, lineNumber: fg('Line Number'), activeLineNumber: fg('Selected Line Number'),
    keyword: fg('Keyword'), comment: fg('Comment'), string: fg('String'), number: fg('Number'), operator: fg('Operator'), preprocessor: fg('Preprocessor Keyword'),
    type: fg('Type'), escape: fg('string - escape character'), htmlElement: fg('HTML Element Name'), htmlAttribute: fg('HTML Attribute Name'),
    htmlValue: fg('HTML Attribute Value'), htmlDelimiter: fg('HTML Tag Delimiter'), razor: mef['Razor Code']?.bg, xmlDoc: fg('XML Doc Comment') };
}

function make(kind, file) {
  const t = readTheme(path.join(platform, file));
  const env = t.Environment;
  const cc = t.CommonControls;
  const tree = t.TreeView;
  const bg = (n) => env[n]?.bg;
  const e = editorOf(kind);
  const r = roslyn[kind];
  const accent = bg('FileTabSelectedBorder');
  const colors = {
    focusBorder: accent, 'textLink.foreground': bg('ControlLinkText'), 'textLink.activeForeground': bg('ControlLinkText'), 'progressBar.background': accent,
    foreground: bg('ToolWindowText'), 'widget.border': bg('CommandBarMenuBorder'),
    // the main window's caption; TitleBarActive* are tool windows' title bars
    'titleBar.activeBackground': env.MainWindowActiveCaption?.bg, 'titleBar.activeForeground': env.MainWindowActiveCaption?.fg,
    'titleBar.inactiveBackground': env.MainWindowInactiveCaption?.bg, 'titleBar.inactiveForeground': env.MainWindowInactiveCaption?.fg,
    'titleBar.border': bg('AccentBorder'), 'window.activeBorder': bg('MainWindowActiveDefaultBorder'), 'window.inactiveBorder': bg('MainWindowInactiveBorder'),
    'menubar.selectionBackground': bg('CommandBarHover'), 'menu.background': bg('CommandBarMenuBackgroundGradientBegin'), 'menu.foreground': bg('CommandBarTextActive'),
    'menu.selectionBackground': env.CommandBarMenuItemMouseOver?.bg, 'menu.selectionForeground': env.CommandBarMenuItemMouseOver?.fg, 'menu.border': bg('CommandBarMenuBorder'),
    'activityBar.background': bg('EnvironmentBackground'), 'activityBar.foreground': bg('ToolWindowText'), 'activityBar.inactiveForeground': bg('FileTabText'),
    'activityBar.activeBorder': accent, 'activityBar.border': bg('AccentBorder'), 'activityBarBadge.background': accent, 'activityBarBadge.foreground': '#FFFFFF',
    'sideBar.background': bg('ToolWindowBackground'), 'sideBar.foreground': bg('ToolWindowText'), 'sideBar.border': bg('ToolWindowBorder'),
    'sideBarTitle.foreground': bg('ToolWindowText'), 'sideBarSectionHeader.background': bg('EnvironmentBackground'), 'sideBarSectionHeader.border': bg('ToolWindowBorder'),
    'list.activeSelectionBackground': tree.SelectedItemActive?.bg, 'list.activeSelectionForeground': tree.SelectedItemActive?.fg,
    'list.inactiveSelectionBackground': tree.SelectedItemInactive?.bg, 'list.inactiveSelectionForeground': tree.SelectedItemInactive?.fg,
    'list.hoverBackground': bg('CommandBarHover'), 'list.focusOutline': accent, 'list.highlightForeground': bg('ControlLinkText'), 'tree.indentGuidesStroke': bg('ToolWindowBorder'),
    'editorGroupHeader.tabsBackground': bg('EnvironmentBackground'), 'editorGroupHeader.tabsBorder': bg('AccentBorder'), 'editorGroup.border': bg('ToolWindowBorder'),
    'tab.activeBackground': bg('FileTabSelectedBackground'), 'tab.activeForeground': bg('FileTabSelectedText'), 'tab.activeBorderTop': accent,
    'tab.unfocusedActiveBackground': bg('FileTabBackground'), 'tab.unfocusedActiveForeground': bg('FileTabLastActiveText'),
    'tab.inactiveBackground': bg('EnvironmentBackground'), 'tab.inactiveForeground': bg('FileTabText'), 'tab.hoverBackground': bg('FileTabHotGradientTop'),
    'tab.hoverForeground': bg('FileTabHotText'), 'tab.border': bg('EnvironmentBackground'),
    'panel.background': bg('ToolWindowBackground'), 'panel.border': bg('ToolWindowBorder'), 'panelTitle.activeForeground': bg('ToolWindowTabSelectedText'),
    'panelTitle.inactiveForeground': bg('ToolWindowTabText'), 'panelTitle.activeBorder': accent,
    'statusBar.background': env.StatusBarDefault?.bg, 'statusBar.foreground': env.StatusBarDefault?.fg, 'statusBar.debuggingBackground': env.StatusBarDebugging?.bg,
    'statusBar.debuggingForeground': env.StatusBarDebugging?.fg, 'statusBar.noFolderBackground': env.StatusBarNoSolution?.bg, 'statusBar.noFolderForeground': env.StatusBarNoSolution?.fg,
    'statusBarItem.hoverBackground': env.StatusBarHighlight?.bg, 'statusBarItem.remoteBackground': accent,
    'input.background': cc.TextBoxBackground?.bg, 'input.foreground': cc.TextBoxText?.bg, 'input.border': cc.TextBoxBorder?.bg,
    'dropdown.background': bg('DropDownBackground'), 'dropdown.foreground': bg('DropDownText'), 'dropdown.border': bg('DropDownBorder'),
    'button.background': cc.ButtonDefault?.bg, 'button.foreground': cc.ButtonDefault?.fg, 'button.hoverBackground': cc.ButtonHover?.bg,
    'button.secondaryBackground': cc.Button?.bg, 'button.secondaryForeground': cc.Button?.fg, 'button.secondaryHoverBackground': cc.ButtonHover?.bg,
    'checkbox.background': cc.TextBoxBackground?.bg, 'checkbox.border': cc.TextBoxBorder?.bg,
    'scrollbarSlider.background': `${bg('ScrollBarThumbBackground')}99`, 'scrollbarSlider.hoverBackground': `${bg('ScrollBarThumbMouseOverBackground')}99`,
    'scrollbarSlider.activeBackground': bg('ScrollBarThumbMouseOverBackground'),
    'editor.background': e.background, 'editor.foreground': e.foreground, 'editor.selectionBackground': e.selection, 'editor.inactiveSelectionBackground': e.inactiveSelection,
    'editorLineNumber.foreground': e.lineNumber, 'editorLineNumber.activeForeground': e.activeLineNumber, 'editorGutter.background': e.background,
    'editorWidget.background': bg('CommandBarMenuBackgroundGradientBegin'), 'editorWidget.border': bg('CommandBarMenuBorder'),
    'editorSuggestWidget.background': bg('CommandBarMenuBackgroundGradientBegin'), 'editorSuggestWidget.border': bg('CommandBarMenuBorder'),
    'editorSuggestWidget.selectedBackground': tree.SelectedItemActive?.bg, 'editorHoverWidget.background': bg('CommandBarMenuBackgroundGradientBegin'),
    'editorHoverWidget.border': bg('CommandBarMenuBorder'), 'quickInput.background': bg('CommandBarMenuBackgroundGradientBegin'),
    'quickInputList.focusBackground': tree.SelectedItemActive?.bg, 'terminal.background': bg('ToolWindowBackground'),
    'notifications.background': bg('CommandBarMenuBackgroundGradientBegin'), 'notifications.border': bg('CommandBarMenuBorder'),
    'breadcrumb.background': e.background, 'debugToolBar.background': bg('CommandBarMenuBackgroundGradientBegin'),
  };
  for (const [k, v] of Object.entries(colors)) if (!v) delete colors[k];
  const scope = (scopes, foreground, fontStyle) => ({ scope: scopes, settings: { foreground, ...(fontStyle ? { fontStyle } : {}) } });
  return {
    $schema: 'vscode://schemas/color-theme',
    name: `Visual Studio 2026 ${kind === 'dark' ? 'Dark' : 'Light'}`,
    type: kind,
    semanticHighlighting: true,
    colors,
    semanticTokenColors: {
      class: r.class, struct: r.struct, interface: r.interface, enum: r.enum, typeParameter: r.typeParameter, delegate: r.delegate, method: r.method,
      function: r.method, extensionMethod: r.method, parameter: r.parameter, variable: r.variable, local: r.variable, property: r.property, field: r.field,
      enumMember: r.enumMember, namespace: r.namespace, controlKeyword: r.controlKeyword, keyword: e.keyword, string: e.string, number: e.number, comment: e.comment,
      operator: e.operator, operatorOverloaded: r.operatorOverloaded, stringEscapeCharacter: e.escape, label: r.label, regexComment: e.comment,
      excludedCode: e.preprocessor, preprocessorText: e.preprocessor,
    },
    tokenColors: [
      scope(['comment', 'punctuation.definition.comment'], e.comment),
      scope(['comment.documentation', 'comment.block.documentation'], e.xmlDoc),
      scope(['keyword', 'storage.type', 'storage.modifier', 'keyword.operator.new', 'keyword.operator.expression', 'constant.language', 'variable.language'], e.keyword),
      scope(['keyword.control', 'keyword.control.flow'], r.controlKeyword),
      scope(['keyword.operator', 'punctuation.accessor'], e.operator),
      scope(['meta.preprocessor', 'keyword.preprocessor', 'punctuation.separator.hash.cs'], e.preprocessor),
      scope(['string', 'punctuation.definition.string'], e.string),
      scope(['constant.character.escape'], e.escape),
      scope(['constant.numeric'], e.number),
      scope(['entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'entity.other.inherited-class', 'storage.type.cs'], r.class),
      scope(['entity.name.type.interface'], r.interface),
      scope(['entity.name.type.enum'], r.enum),
      scope(['entity.name.type.struct'], r.struct),
      scope(['entity.name.function', 'support.function'], r.method),
      scope(['variable.parameter'], r.parameter),
      scope(['variable', 'variable.other'], r.variable),
      scope(['entity.name.tag', 'punctuation.definition.tag.html', 'meta.tag'], e.htmlElement),
      scope(['punctuation.definition.tag'], e.htmlDelimiter),
      scope(['entity.other.attribute-name'], e.htmlAttribute),
      scope(['string.quoted.double.html', 'string.quoted.single.html', 'meta.attribute string'], e.htmlValue),
      scope(['keyword.control.razor', 'keyword.control.cshtml', 'meta.directive.razor', 'keyword.other.razor', 'punctuation.definition.razor'], e.keyword),
      scope(['support.type.property-name.css', 'support.type.property-name'], r.parameter),
      scope(['entity.other.attribute-name.class.css', 'entity.other.attribute-name.id.css', 'entity.name.tag.css'], kind === 'dark' ? '#D7BA7D' : '#800000'),
    ],
  };
}

const out = path.join(__dirname, '..', 'themes');
fs.mkdirSync(out, { recursive: true });
for (const [kind, file] of [['dark', 'Theme.Dark.pkgdef'], ['light', 'Theme.Light.pkgdef']]) {
  const theme = make(kind, file);
  fs.writeFileSync(path.join(out, `visual-studio-2026-${kind}-color-theme.json`), `${JSON.stringify(theme, null, 2)}\n`);
  console.log(`${theme.name}: ${Object.keys(theme.colors).length} colours`);
}
