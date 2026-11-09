// CSS classes complete in a class="…" of a .razor/.cshtml, from every stylesheet the app's pages use, as VS completes them:
// a component's pages are those of its project and of the projects that reference it (App.razor, _Layout.cshtml, a
// wwwroot index.html), and their <link>s are followed as the app serves them: the CSS isolation bundle (each *.razor.css
// of the projects it takes in), wwwroot, a referenced project's or a package's static web assets (_content/<id>/…), a
// CDN's address (fetched once, kept in the extension's storage); with their @imports, and the pages' <style> blocks.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assets = require('./web-assets');

/** The classes a stylesheet's selectors name, its comments, strings and declarations passed over. */
function cssClasses(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Set();
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = css.indexOf(c, i + 1);
      i = end < 0 ? css.length : end;
    } else if (c === '{') {
      const prelude = css.slice(start, i).replace(/"[^"]*"|'[^']*'/g, '');
      if (!/^\s*@/.test(prelude)) for (const m of prelude.matchAll(/\.(-?[_a-zA-Z -￿][\w -￿-]*)/g)) found.add(m[1]);
      start = i + 1;
    } else if (c === '}' || c === ';') {
      start = i + 1;
    }
  }
  return found;
}

/** What a page links and its <style> blocks: the hrefs of its stylesheets (an @Assets["…"] read as its address). */
function pageStyles(text) {
  const links = [];
  for (const [tag] of text.matchAll(/<link\b(?:"[^"]*"|'[^']*'|[^>])*>/gi)) {
    const href = /\bhref\s*=\s*"@Assets\[\s*"([^"]+)"\s*\]"/i.exec(tag)?.[1] ?? /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)?.slice(1).find((h) => h !== undefined);
    if (href && !href.startsWith('@') && (/\brel\s*=\s*["']?stylesheet/i.test(tag) || /\.css([?#]|$)/i.test(href))) links.push(href);
  }
  const blocks = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  return { links, blocks };
}

/** Whether the offset stands in the value of a class attribute. */
function inClassValue(text, offset) {
  return /\bclass\s*=\s*(["'])[^"'<>]*$/i.test(text.slice(Math.max(0, offset - 2000), offset));
}

function registerCssClasses(context) {
  const storage = path.join(context.globalStorageUri.fsPath, 'stylesheets');
  const remote = new Map(); // url -> Promise of its text, or null where it could not be had
  const read = new Map(); // file -> { mtime, value }: what was read of it, read again once it changes

  const once = (file, make) => {
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && assets.same(d.fileName, file));
    if (open?.isDirty) return make(open.getText());
    const had = read.get(file);
    if (had?.mtime === mtime) return had.value;
    let value;
    try { value = make(fs.readFileSync(file, 'utf8')); } catch { return null; }
    read.set(file, { mtime, value });
    return value;
  };

  /** A CDN's stylesheet, fetched once: kept in the extension's storage, read from there afterwards. */
  const fetched = (url) => {
    if (!remote.has(url)) {
      remote.set(url, (async () => {
        const file = path.join(storage, `${crypto.createHash('sha1').update(url).digest('hex')}.css`);
        try { return fs.readFileSync(file, 'utf8'); } catch { /* not fetched yet */ }
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`${response.status}`);
        const text = await response.text();
        fs.mkdirSync(storage, { recursive: true });
        fs.writeFileSync(file, text);
        return text;
      })().catch(() => {
        remote.delete(url); // asked again next time
        return null;
      }));
    }
    return remote.get(url);
  };

  /** The classes of the stylesheets an app's pages link, each with the stylesheet's name; `waiting` the CDNs not fetched yet. */
  async function classesFor(document) {
    const project = assets.projectOf(document.fileName);
    const classes = new Map();
    const add = (set, from) => { for (const c of set || []) if (!classes.has(c)) classes.set(c, from); };
    if (!project) return { classes, waiting: [] };
    const projects = (await vscode.workspace.findFiles('**/*.{csproj,fsproj,vbproj}', '**/{node_modules,bin,obj}/**')).map((u) => u.fsPath);
    const serving = assets.referencingTo(project, projects);
    const seen = new Set();
    const waiting = [];
    const remoteSheets = [];

    const sheet = (file, depth) => {
      if (seen.has(file)) return;
      seen.add(file);
      const value = once(file, (css) => ({ classes: cssClasses(css), imports: imports(css) }));
      if (!value) return;
      add(value.classes, path.basename(file));
      if (depth < 3) for (const i of value.imports) link(/^(https?:)?\/\//i.test(i) ? i : path.resolve(path.dirname(file), assets.appPath(i)), null, depth + 1);
    };
    const link = (href, servedBy, depth = 0) => {
      if (/^(https?:)?\/\//i.test(href)) {
        const url = href.startsWith('//') ? `https:${href}` : href;
        if (!seen.has(url)) {
          seen.add(url);
          remoteSheets.push(url);
        }
        return;
      }
      if (!servedBy) return sheet(href, depth);
      const bundle = /^(?:.*\/)?([^/]+?)\.(?:styles|bundle\.scp)\.css$/i.exec(assets.appPath(href));
      const target = bundle && [servedBy, ...projects].find((p) => assets.same(assets.projectName(p), bundle[1]));
      if (target) {
        // The CSS isolation bundle: the scoped stylesheets of the project and those it references, from their sources.
        for (const p of assets.referencedFrom(target)) {
          for (const f of assets.filesUnder(path.dirname(p), (n) => /\.(razor|cshtml)\.css$/i.test(n))) sheet(f, depth);
        }
        return;
      }
      const file = assets.assetFile(servedBy, href);
      if (file) sheet(file, depth);
    };

    // The component's own text, as it is in the editor, and its own scoped stylesheet.
    for (const block of pageStyles(document.getText()).blocks) add(cssClasses(block), path.basename(document.fileName));
    const scoped = `${document.fileName}.css`;
    if (fs.existsSync(scoped)) sheet(scoped, 0);
    for (const p of serving) {
      const pages = assets.filesUnder(path.dirname(p), (n) => /\.(razor|cshtml)$/i.test(n))
        .concat(assets.filesUnder(path.join(path.dirname(p), 'wwwroot'), (n) => /\.html?$/i.test(n)));
      for (const page of pages) {
        if (assets.same(page, document.fileName)) continue;
        const styles = once(page, pageStyles);
        if (!styles) continue;
        for (const block of styles.blocks) add(cssClasses(block), path.basename(page));
        for (const href of styles.links) link(href, p);
      }
    }
    for (const url of remoteSheets) {
      const text = fetched(url);
      const name = path.basename(new URL(url).pathname) || url;
      waiting.push(text.then((css) => css && add(cssClasses(css), name)));
    }
    return { classes, waiting };
  }

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'aspnetcorerazor' }, {
    async provideCompletionItems(document, position) {
      if (!inClassValue(document.getText(), document.offsetAt(position))) return undefined;
      const { classes, waiting } = await classesFor(document);
      // A CDN's stylesheet not fetched yet: the list waits for it a moment, else says it is incomplete, to be asked again.
      const all = Promise.all(waiting);
      const late = !(await Promise.race([all.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]));
      const line = document.lineAt(position.line).text;
      const before = /[\w-]*$/.exec(line.slice(0, position.character))[0].length;
      const after = /^[\w-]*/.exec(line.slice(position.character))[0].length;
      const range = new vscode.Range(position.line, position.character - before, position.line, position.character + after);
      const items = [...classes].map(([name, from]) => {
        const item = new vscode.CompletionItem({ label: name, description: from }, vscode.CompletionItemKind.Value);
        item.detail = from;
        item.range = range;
        return item;
      });
      return new vscode.CompletionList(items, late);
    },
  }, '"', "'", ' '));
}

/** A stylesheet's @imports' addresses. */
function imports(css) {
  return [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)].map((m) => m[1]);
}

module.exports = { registerCssClasses, cssClasses, pageStyles, inClassValue };
