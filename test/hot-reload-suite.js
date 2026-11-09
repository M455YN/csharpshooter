// Hot Reload under the debugger, in a real editor on small web apps of the test's own: a method body and a .cshtml edited
// and saved while the app runs reach it without a restart; an edit the runtime cannot take is reported, not applied. After
// an update the program's MetadataUpdateHandlers run and a page open over the SDK's browser refresh is refreshed; a saved
// stylesheet is applied in the page without a reload, a component's scoped CSS once bundled again, any other static file
// reloads it; and a Blazor component, in headless Chrome, shows its edit as it renders again, the page not reloaded.
//   node test/hot-reload-suite.js <empty folder>        (makes the apps: dotnet new webapp with a /value endpoint, dotnet new blazor)
//   EDITOR_EXE=<editor exe> WORKSPACE=<that folder> SUITE=test/hot-reload-suite.js node test/runTest.js
// The Blazor check starts Chrome (CHROME=<chrome.exe or msedge.exe> for another).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const URL_ = 'http://127.0.0.1:5197';
const BLAZOR = 'http://127.0.0.1:5198';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (require.main === module) {
  const folder = path.resolve(process.argv[2]);
  const { execFileSync } = require('child_process');
  execFileSync('dotnet', ['new', 'webapp', '-n', 'WebApp', '-o', path.join(folder, 'WebApp')], { stdio: 'inherit' });
  execFileSync('dotnet', ['new', 'blazor', '-n', 'BlazorApp', '-o', path.join(folder, 'BlazorApp')], { stdio: 'inherit' });
  execFileSync('dotnet', ['new', 'sln', '-n', 'WebApp', '-o', folder], { stdio: 'inherit' });
  const sln = path.join(folder, fs.readdirSync(folder).find((f) => /\.slnx?$/.test(f)));
  execFileSync('dotnet', ['sln', sln, 'add', path.join(folder, 'WebApp', 'WebApp.csproj'), path.join(folder, 'BlazorApp', 'BlazorApp.csproj')], { stdio: 'inherit' });
  fs.writeFileSync(path.join(folder, 'WebApp', 'Values.cs'), 'namespace WebApp;\n\npublic static class Values\n{\n    public static string Text()\n    {\n        return "one";\n    }\n}\n');
  // A MetadataUpdateHandler of the app's own, which says at /handlers what was called of it.
  fs.writeFileSync(path.join(folder, 'WebApp', 'UpdateHandler.cs'), '[assembly: System.Reflection.Metadata.MetadataUpdateHandler(typeof(WebApp.UpdateHandler))]\n\nnamespace WebApp;\n\n'
    + 'public static class UpdateHandler\n{\n    public static readonly List<string> Calls = new();\n\n'
    + '    internal static void ClearCache(Type[]? types) => Calls.Add("ClearCache");\n\n'
    + '    internal static void UpdateApplication(Type[]? types) => Calls.Add("UpdateApplication");\n}\n');
  const program = path.join(folder, 'WebApp', 'Program.cs');
  fs.writeFileSync(program, fs.readFileSync(program, 'utf8').replace('app.MapRazorPages()',
    'app.MapGet("/value", () => WebApp.Values.Text());\napp.MapGet("/handlers", () => string.Join(",", WebApp.UpdateHandler.Calls));\napp.MapRazorPages()'));
  process.exit(0);
}

const vscode = require('vscode');

const get = (url, headers) => new Promise((resolve) => {
  http.get(url, { headers }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve(body));
  }).on('error', () => resolve(undefined));
});

async function replaceAndSave(file, from, to) {
  const doc = await vscode.workspace.openTextDocument(file);
  const at = from === null ? doc.getText().length : doc.getText().indexOf(from);
  if (at < 0) throw new Error(`${from} is not in ${file}`);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + (from === null ? 0 : from.length))), to);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

/** A WebSocket client, as much of one as the checks need: text messages each way. */
function connect(url, { origin, protocol } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port), u.hostname);
    const key = crypto.randomBytes(16).toString('base64');
    const listeners = [];
    const messages = [];
    let buffer = Buffer.alloc(0);
    let open = false;
    socket.on('error', reject);
    socket.on('connect', () => socket.write([`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', ...(origin ? [`Origin: ${origin}`] : []),
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n')));
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!open) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error(head.split('\r\n')[0]));
        open = true;
        resolve({
          messages,
          on: (listener) => listeners.push(listener),
          send(text) {
            const payload = Buffer.from(text);
            const mask = crypto.randomBytes(4);
            const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
              : payload.length < 65536 ? Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255])
                : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(payload.length), 2); return b; })();
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            socket.write(Buffer.concat([head, mask, payload]));
          },
          close: () => socket.destroy(),
        });
      }
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          at = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          at = 10;
        }
        if (buffer.length < at + length) return;
        const opcode = buffer[0] & 0x0f;
        const text = buffer.subarray(at, at + length).toString();
        buffer = buffer.subarray(at + length);
        if (opcode === 1) {
          messages.push(text);
          listeners.forEach((l) => l(text));
        }
      }
    });
  });
}

/** A page of the app as its browser refresh script connects it: the script the middleware put in the page read for the
 *  socket and the key, a secret encrypted with the key given as the protocol, as the SDK's script does. */
async function openPage(base) {
  // The middleware puts its script only in a page the browser loads as a document.
  const html = await get(`${base}/`, { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' });
  const src = /<script src="([^"]*aspnetcore-browser-refresh\.js)"/.exec(html || '')?.[1];
  if (!src) throw new Error('the page has no browser refresh script');
  const script = await get(new URL(src, base).toString());
  const urls = /const webSocketUrls = '([^']*)'/.exec(script)?.[1];
  const serverKey = /getSecret\('([^']*)'\)/.exec(script)?.[1];
  if (!urls) throw new Error('the browser refresh script names no socket');
  const key = crypto.createPublicKey({ key: Buffer.from(serverKey, 'base64'), format: 'der', type: 'spki' });
  const encrypted = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, crypto.randomBytes(32)).toString('base64');
  return connect(urls.split(',')[0], { origin: base, protocol: encodeURIComponent(encrypted) });
}

const nextMessage = (page, ms = 15000) => new Promise((resolve) => {
  const seen = page.messages.length;
  const check = setInterval(() => {
    if (page.messages.length > seen) {
      clearInterval(check);
      resolve(JSON.parse(page.messages[seen]));
    }
  }, 50);
  setTimeout(() => (clearInterval(check), resolve(undefined)), ms);
});

/** Headless Chrome (or CHROME's browser) on a page, driven over its DevTools protocol: evaluate(expression) → its value. */
async function browser(url) {
  const exe = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => p && fs.existsSync(p));
  if (!exe) throw new Error('no Chrome or Edge (set CHROME)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'csharpshooter-chrome-'));
  const child = require('child_process').spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(200);
    try {
      port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      // not yet
    }
  }
  if (!port) throw new Error(`${exe} did not open its DevTools port`);
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = JSON.parse((await get(`http://127.0.0.1:${port}/json/list`)) || '[]').find((t) => t.type === 'page');
    if (!target) await sleep(200);
  }
  const devtools = await connect(target.webSocketDebuggerUrl);
  let id = 0;
  const evaluate = (expression) => new Promise((resolve) => {
    const asked = ++id;
    devtools.on((text) => {
      const answer = JSON.parse(text);
      if (answer.id === asked) resolve(answer.result?.result?.value);
    });
    devtools.send(JSON.stringify({ id: asked, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  return {
    evaluate,
    close() {
      devtools.close();
      child.kill();
      setTimeout(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }), 2000);
    },
  };
}

async function waitFor(check, ms = 30000) {
  let value;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if ((value = await check())) return value;
  return value;
}

async function run() {
  const lines = [];
  let failed = 0;
  const expect = (name, ok, got) => {
    failed += ok ? 0 : 1;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}`);
  };
  const ext = vscode.extensions.getExtension('M455YN.csharpshooter');
  const api = await ext.activate();
  await api.whenReady();
  for (let i = 0; i < 600 && api.loading() && !api.loading().done; i++) await sleep(500);
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const values = path.join(root, 'WebApp', 'Values.cs');
  const page = path.join(root, 'WebApp', 'Pages', 'Index.cshtml');
  const siteCss = path.join(root, 'WebApp', 'wwwroot', 'css', 'site.css');
  const siteJs = path.join(root, 'WebApp', 'wwwroot', 'js', 'site.js');
  const layoutCss = path.join(root, 'WebApp', 'Pages', 'Shared', '_Layout.cshtml.css');
  const counter = path.join(root, 'BlazorApp', 'Components', 'Pages', 'Counter.razor');
  if (!fs.existsSync(counter) || !fs.existsSync(path.join(root, 'WebApp', 'UpdateHandler.cs'))) {
    throw new Error(`${root} was made by an older suite: make it again with node test/hot-reload-suite.js <empty folder>`);
  }
  const kept = [values, page, siteCss, siteJs, layoutCss, counter].map((f) => [f, fs.readFileSync(f)]);
  const applied = () => new Promise((r) => {
    const d = api.hotReload.applied.event((o) => (d.dispose(), r(o)));
    setTimeout(() => (d.dispose(), r({ result: 'timeout', said: 'no outcome in 60 s' })), 60000);
  });
  const staticTold = () => new Promise((r) => {
    const d = api.hotReload.staticFiles.event((told) => (d.dispose(), r(told)));
    setTimeout(() => (d.dispose(), r([])), 60000);
  });
  let open;
  let chrome;
  try {
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
      type: 'csharpshooter', request: 'launch', name: 'WebApp', project: path.join(root, 'WebApp', 'WebApp.csproj'),
      startupProject: false, launchProfile: 'https', launchBrowser: false, env: { ASPNETCORE_URLS: URL_ },
    });
    let body;
    for (let i = 0; i < 120 && !(body = await get(`${URL_}/value`)); i++) await sleep(500);
    const session = vscode.debug.activeDebugSession;
    expect('the app runs under the debugger with Hot Reload on', body === 'one' && session?.configuration.hotReload === true,
      `/value ${body}, hotReload ${session?.configuration.hotReload}`);
    const env = session?.configuration.env || {};
    expect('the update handlers\' hook and the SDK\'s browser refresh are loaded into it', /CSharpShooter\.UpdateHandlers\.dll/.test(env.DOTNET_STARTUP_HOOKS || '')
      && /Microsoft\.AspNetCore\.Watch\.BrowserRefresh\.dll/.test(env.DOTNET_STARTUP_HOOKS || '') && !!env.ASPNETCORE_AUTO_RELOAD_WS_ENDPOINT,
    `DOTNET_STARTUP_HOOKS ${env.DOTNET_STARTUP_HOOKS}, endpoint ${env.ASPNETCORE_AUTO_RELOAD_WS_ENDPOINT}, extras ${session?.configuration.__hotReloadExtras}`);

    try {
      open = await openPage(URL_);
    } catch (e) {
      open = undefined;
      expect('a page connects over the browser refresh socket', false, e.message);
    }

    let outcome = applied();
    let message = open && nextMessage(open, 70000);
    await replaceAndSave(values, '"one"', '"two"');
    outcome = await outcome;
    body = await get(`${URL_}/value`);
    expect('a method body changed and saved runs at once', outcome.result === 'applied' && body === 'two', `${outcome.result}: ${outcome.said}; /value ${body}`);
    message = await message;
    expect('the page open is refreshed after the update', message?.type === 'RefreshBrowser' && outcome.pages === 1, `${JSON.stringify(message)}, pages ${outcome.pages}`);
    const handlers = await get(`${URL_}/handlers`);
    expect('the app\'s MetadataUpdateHandlers ran, ClearCache then UpdateApplication', handlers === 'ClearCache,UpdateApplication' && Array.isArray(outcome.handlers) && !outcome.handlers.length,
      `/handlers ${handlers}, failures ${JSON.stringify(outcome.handlers)}`);

    outcome = applied();
    await replaceAndSave(page, 'Welcome', 'Witaj');
    outcome = await outcome;
    body = await get(`${URL_}/`);
    expect('a .cshtml line changed and saved is in the next response', outcome.result === 'applied' && /Witaj/.test(body || ''), `${outcome.result}: ${outcome.said}; page has Witaj: ${/Witaj/.test(body || '')}`);
    await sleep(1000); // its refresh has reached the page

    let told = staticTold();
    message = open && nextMessage(open, 30000);
    await replaceAndSave(siteCss, null, '\nh1 { color: rgb(1, 2, 3); }\n');
    told = await told;
    message = await message;
    const css = await get(`${URL_}/css/site.css`);
    expect('a saved stylesheet is applied in the page without a reload', message?.type === 'UpdateStaticFile' && message.path === 'css/site.css' && /rgb\(1, 2, 3\)/.test(css || ''),
      `${JSON.stringify(message)}; told ${JSON.stringify(told)}; served has the rule: ${/rgb\(1, 2, 3\)/.test(css || '')}`);

    told = staticTold();
    message = open && nextMessage(open, 60000);
    await replaceAndSave(layoutCss, null, '\nfooter { color: rgb(4, 5, 6); }\n');
    told = await told;
    message = await message;
    const styles = await get(`${URL_}/WebApp.styles.css`);
    expect('a scoped stylesheet saved is bundled again and applied without a reload', message?.type === 'UpdateStaticFile' && message.path === 'WebApp.styles.css' && /rgb\(4, 5, 6\)/.test(styles || ''),
      `${JSON.stringify(message)}; told ${JSON.stringify(told)}; bundle has the rule: ${/rgb\(4, 5, 6\)/.test(styles || '')}`);

    told = staticTold();
    message = open && nextMessage(open, 30000);
    await replaceAndSave(siteJs, null, '\n// changed\n');
    told = await told;
    message = await message;
    expect('any other static file saved reloads the page', message?.type === 'UpdateStaticFile' && message.path === 'js/site.js', `${JSON.stringify(message)}; told ${JSON.stringify(told)}`);

    outcome = applied();
    await replaceAndSave(values, 'public static string Text()', 'public static string Text(int times = 1)');
    outcome = await outcome;
    body = await get(`${URL_}/value`);
    expect('an edit the runtime cannot take is reported, not applied', ['restart', 'errors'].includes(outcome.result) && body === 'two',
      `${outcome.result}: ${outcome.said}; /value ${body}`);
    const shown = vscode.languages.getDiagnostics(vscode.Uri.file(values)).filter((d) => d.source === 'Hot Reload');
    expect('it is in Problems', shown.length > 0 || outcome.result === 'errors', shown.map((d) => `${d.code} ${d.message}`).join('; ') || 'none');
    open?.close();
    open = undefined;
    await vscode.debug.stopDebugging();
    await sleep(2000);

    // A Blazor component, interactive on the server, in a real browser: clicked to 3, its markup edited, it shows the edit as
    // its handlers render it again, its count kept: the page was not loaded again.
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
      type: 'csharpshooter', request: 'launch', name: 'BlazorApp', project: path.join(root, 'BlazorApp', 'BlazorApp.csproj'),
      startupProject: false, launchProfile: 'http', launchBrowser: false, env: { ASPNETCORE_URLS: BLAZOR },
    });
    for (let i = 0; i < 120 && !(await get(`${BLAZOR}/counter`)); i++) await sleep(500);
    let shownText;
    try {
      chrome = await browser(`${BLAZOR}/counter`);
      const status = () => chrome.evaluate('document.querySelector("[role=status]")?.textContent || ""');
      await waitFor(async () => (await chrome.evaluate('!!(window.Blazor && document.querySelector("button.btn"))')));
      // The circuit is up once a click counts.
      await waitFor(async () => {
        await chrome.evaluate('document.querySelector("button.btn").click()');
        await sleep(300);
        return /: [1-9]/.test(await status());
      });
      await waitFor(async () => {
        const now = Number(/(\d+)$/.exec(await status())?.[1]);
        if (now >= 3) return true;
        await chrome.evaluate('document.querySelector("button.btn").click()');
        await sleep(200);
        return false;
      });
      const before = await status();
      await chrome.evaluate('window.__notReloaded = true');
      outcome = applied();
      await replaceAndSave(counter, 'Current count:', 'Licznik:');
      outcome = await outcome;
      shownText = await waitFor(async () => (/Licznik/.test(await status()) ? status() : undefined), 15000);
      const notReloaded = await chrome.evaluate('window.__notReloaded === true');
      expect('a Blazor component shows its edit as it renders again, the page not reloaded', outcome.result === 'applied' && /Licznik/.test(shownText || '') && notReloaded && Array.isArray(outcome.handlers) && !outcome.handlers.length,
        `${outcome.result}: ${outcome.said}; before "${before}", now "${shownText || (await status())}", not reloaded ${notReloaded}, handlers ${JSON.stringify(outcome.handlers)}`);
    } catch (e) {
      expect('a Blazor component shows its edit as it renders again, the page not reloaded', false, e.message);
    }
  } finally {
    open?.close();
    chrome?.close();
    await vscode.debug.stopDebugging();
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const [file, content] of kept) fs.writeFileSync(file, content);
  }
  console.log(lines.join('\n'));
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
