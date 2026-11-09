// The SDK's own browser refresh for a web app debugged with Hot Reload, keeping its open pages up as dotnet watch does
// (Passenger's BrowserRefresh at 9954e4b, MIT): the SDK's middleware (Microsoft.AspNetCore.Watch.BrowserRefresh) of the SDK
// the app builds with, loaded into the app as a startup hook and hosting startup, has its browser script, the SDK's too,
// connect to the WebSocket served here. A stylesheet the app serves changed (its own, or a referenced project's, a Razor
// class library's) is applied in the page with no reload (a component's scoped CSS bundled again by its project first),
// any other static file changed reloads the page, and an update applied refreshes it. Before .NET 11 the page connects here
// itself and encrypts its secret with this server's key; from 11 the app forwards it, and the server proves itself with the
// key the app's build made.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { t, tn } = require('./l10n');

const MIDDLEWARE = 'Microsoft.AspNetCore.Watch.BrowserRefresh.dll';
const PRIVATE_KEY = 'browser-tools-key.private.json';
const MANIFEST = 'staticwebassets.development.json';
const ROUTES = '/_framework/dotnet-browser-tools';
const VARIABLES = {
  hooks: 'DOTNET_STARTUP_HOOKS',
  hostingStartup: 'ASPNETCORE_HOSTINGSTARTUPASSEMBLIES',
  endpoint: 'ASPNETCORE_AUTO_RELOAD_WS_ENDPOINT',
  key: 'ASPNETCORE_AUTO_RELOAD_WS_KEY',
  provider: 'ASPNETCORE_AUTO_RELOAD_PROVIDER_ADDRESS',
};
const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isUnder = (file, folder) => {
  const relative = path.relative(folder, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const isScopedCss = (file) => /\.(razor|cshtml)\.css$/i.test(file);

/** The SDK's middleware and whether it is the one the app forwards to us (.NET 11's), by the variable it reads: no path
 *  where the SDK has none, forwarded undefined where it reads neither. */
function middlewareOf(sdk) {
  const tools = path.join(sdk, 'DotnetTools', 'dotnet-watch');
  const find = (folder, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const here = entries.find((e) => e.isFile() && e.name === MIDDLEWARE);
    if (here) return path.join(folder, here.name);
    for (const e of entries.filter((e) => e.isDirectory() && depth < 8)) {
      const found = find(path.join(folder, e.name), depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  const middleware = find(tools, 0);
  if (!middleware) return {};
  let read;
  try {
    read = fs.readFileSync(middleware);
  } catch {
    return {};
  }
  // Its user strings are UTF-16.
  const reads = (name) => read.indexOf(Buffer.from(name, 'utf16le')) >= 0;
  return { middleware, forwarded: reads(VARIABLES.provider) ? true : reads(VARIABLES.endpoint) ? false : undefined };
}

/** A web app's static web assets as its build's development manifest maps them: each file by the URL the app serves it at
 *  (a referenced project's under _content/Name/), the folders whose files it serves as they come, and where the SDK's
 *  browser tools it serves were written. Undefined for text that is no manifest. */
function readAssets(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  const roots = manifest?.ContentRoots;
  if (!Array.isArray(roots) || !roots.length || !manifest.Root) return undefined;
  const urls = new Map(); // lower-case file → [file, url]
  const folders = [];
  let browserTools;
  const rootOf = (entry) => {
    const i = entry?.ContentRootIndex;
    return Number.isInteger(i) && i >= 0 && i < roots.length && path.isAbsolute(roots[i]) ? roots[i] : undefined;
  };
  const take = (node, url, depth) => {
    if (!node || depth > 64) return;
    for (const [name, child] of Object.entries(node.Children || {})) take(child, url ? `${url}/${name}` : name, depth + 1);
    const asset = node.Asset;
    const root = rootOf(asset);
    if (asset && url && root && asset.SubPath) {
      const file = path.join(root, asset.SubPath.replace(/\//g, path.sep));
      const known = urls.get(file.toLowerCase());
      if (!known || url.length < known[1].length) urls.set(file.toLowerCase(), [file, url]);
      if (!browserTools && url.startsWith('_framework/') && url.endsWith('.BrowserTools.Config.js')) browserTools = path.dirname(file);
    }
    for (const pattern of node.Patterns || []) {
      const folder = rootOf(pattern);
      if (pattern.Pattern === '**' && folder) folders.push([folder.replace(/[\\/]+$/, ''), url]);
    }
  };
  take(manifest.Root, '', 0);
  return {
    browserTools,
    urlOf(file) {
      const known = urls.get(path.resolve(file).toLowerCase());
      if (known) return known[1];
      for (const [folder, under] of folders) {
        if (isUnder(file, folder)) {
          const relative = path.relative(folder, file).split(path.sep).join('/');
          return under ? `${under}/${relative}` : relative;
        }
      }
      return undefined;
    },
    /** The URL the app serves a referenced project's scoped CSS bundle at, without a fingerprint. */
    bundleUrlOf(project) {
      const bundle = `${path.basename(project, path.extname(project))}.bundle.scp.css`.toLowerCase();
      for (const [file, url] of urls.values()) {
        if (path.basename(file).toLowerCase() === bundle) {
          const slash = url.lastIndexOf('/');
          return slash < 0 ? path.basename(file) : `${url.slice(0, slash)}/${path.basename(file)}`;
        }
      }
      return undefined;
    },
    bundleFileOf(project, own) {
      const bundle = `${path.basename(project, path.extname(project))}${own ? '.styles.css' : '.bundle.scp.css'}`.toLowerCase();
      return [...urls.values()].map(([file]) => file).find((file) => path.basename(file).toLowerCase() === bundle);
    },
  };
}

/** A list variable with first first, the values the program's environment gives (else ours) after it. */
function first(env, variable, value, separator) {
  const others = env[variable] ?? process.env[variable];
  return others ? `${value}${separator}${others}` : value;
}

// ---- WebSocket, as much of it as the page's script speaks: text messages, ping and close.

const ACCEPT = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** A page's socket once its handshake is answered: send(text) → whether it went, and its messages, until it closes. */
function webSocket(socket, onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  let parts = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    onClose();
  };
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 4 << 20) return close();
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      const masked = buffer[1] & 0x80;
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
      const mask = masked ? buffer.subarray(at, at + 4) : undefined;
      at += masked ? 4 : 0;
      if (buffer.length < at + length) return;
      const payload = Buffer.from(buffer.subarray(at, at + length));
      buffer = buffer.subarray(at + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 8) return close();
      if (opcode === 9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload.subarray(0, 125)]));
        continue;
      }
      if (opcode === 10) continue;
      parts.push(payload);
      if (fin) {
        const message = Buffer.concat(parts).toString('utf8');
        parts = [];
        onMessage(message);
      }
    }
  });
  socket.on('close', close);
  socket.on('error', close);
  return {
    send: (text) => {
      if (closed || !socket.writable) return false;
      socket.write(frame(text));
      return true;
    },
    close,
  };
}

/** The refresh for a web app about to be debugged with Hot Reload: { refresh, env } with the variables that load the SDK's
 *  middleware over env, or { said } where the browser cannot be kept up; undefined for an app that is no web app.
 *  props: the project's MSBuild properties (MSBuildExtensionsPath, UsingMicrosoftNETSdkWeb, IntermediateOutputPath,
 *  TargetFrameworkVersion, ProjectReferences); build: { properties: ['-p:…'] } given to its scoped CSS's bundling. */
async function prepareBrowserRefresh(project, props, env, build) {
  if (!/^true$/i.test(props?.UsingMicrosoftNETSdkWeb || '') || !props.MSBuildExtensionsPath || !props.IntermediateOutputPath) return undefined;
  const name = path.basename(project, path.extname(project));
  const major = Number(/^v?(\d+)/.exec(props.TargetFrameworkVersion || '')?.[1]);
  if (major && major < 6) return { said: t("Hot Reload: the browser is not kept up: {0} runs on .NET {1}, older than the SDK's browser refresh (.NET 6).", name, major) };
  const sdk = props.MSBuildExtensionsPath.replace(/[\\/]+$/, '');
  const { middleware, forwarded } = middlewareOf(sdk);
  if (!middleware || forwarded === undefined) {
    return { said: middleware ? t('Hot Reload: the browser is not kept up: the SDK {0} that {1} builds with has a browser refresh CSharpShooter does not speak.', path.basename(sdk), name)
      : t('Hot Reload: the browser is not kept up: the SDK {0} that {1} builds with has no browser refresh.', path.basename(sdk), name) };
  }
  const intermediate = path.resolve(path.dirname(project), props.IntermediateOutputPath);
  let keyFile;
  if (forwarded) {
    let assets;
    try {
      assets = readAssets(fs.readFileSync(path.join(intermediate, MANIFEST), 'utf8'));
    } catch {
      // no manifest: no browser tools
    }
    if (!assets?.browserTools) return { said: t("Hot Reload: the browser is not kept up: {0}'s build made no browser tools for its pages (a build with EnableHotReloadInRuntimeConfigDevFile, as a Debug build has it).", name) };
    keyFile = path.join(assets.browserTools, PRIVATE_KEY);
    if (!fs.existsSync(keyFile)) return { said: t("Hot Reload: the browser is not kept up: the key {0}'s build made for its browser tools is gone: build {0} again.", name) };
  }
  const own = forwarded ? undefined : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const refresh = new BrowserRefresh(project, intermediate, props.ProjectReferences || [], build, own, keyFile);
  const address = `127.0.0.1:${await refresh.listening}`;
  const added = {
    [VARIABLES.hooks]: first(env, VARIABLES.hooks, middleware, path.delimiter),
    [VARIABLES.hostingStartup]: first(env, VARIABLES.hostingStartup, path.basename(MIDDLEWARE, '.dll'), ';'),
  };
  if (own) {
    added[VARIABLES.endpoint] = `ws://${address}`;
    added[VARIABLES.key] = own.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  } else {
    added[VARIABLES.provider] = `http://${address}/`;
  }
  return { refresh, env: { ...env, ...added } };
}

class BrowserRefresh {
  constructor(project, intermediate, referenced, build, own, keyFile) {
    this.project = project;
    this.intermediate = intermediate;
    this.referenced = referenced;
    this.build = build;
    this.own = own;
    this.keyFile = keyFile;
    this.pages = new Set();
    this.told = new Map(); // lower-case file → its stamp as last told
    this.telling = Promise.resolve();
    this.says = () => {};
    this.server = http.createServer((req, res) => this.serve(req, res));
    this.server.on('upgrade', (req, socket) => this.connect(req, socket));
    this.server.on('clientError', (e, socket) => socket.destroy());
    this.listening = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  /** From .NET 11 the app's forwarded settings and cache clearing; anything else is no route. */
  serve(req, res) {
    const route = (req.url || '').split('?')[0];
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') res.statusCode = 405;
    else if (this.keyFile && route === `${ROUTES}/hot-reload-settings.json`) {
      res.setHeader('Content-Type', 'application/json');
      return res.end('{ "hotReload": true }');
    } else if (this.keyFile && route === `${ROUTES}/clear-cache`) {
      res.setHeader('Clear-Site-Data', '"cache"');
      res.statusCode = 204;
    } else res.statusCode = 404;
    res.end();
  }

  /** A page's connection, from this machine's pages alone: its secret, encrypted with the key it was given, read back for
   *  it (from .NET 11 sent first, the page answering before it hears anything else), then held until it goes. */
  connect(req, socket) {
    const refuse = (status) => socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    const route = (req.url || '').split('?')[0];
    if (req.method !== 'GET' || (this.keyFile && route !== `${ROUTES}/connect`)) return refuse(404);
    if (!/^websocket$/i.test(req.headers.upgrade || '') || !req.headers['sec-websocket-key']) return refuse(400);
    let origin;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      return refuse(403);
    }
    const host = origin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!(host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1')) return refuse(403);
    const asked = (req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean);
    const secret = asked.length === 1 ? this.decrypted(decodeURIComponent(asked[0])) : undefined;
    if (!secret && (this.keyFile || asked.length)) return refuse(400);
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + ACCEPT).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
      ...(asked.length === 1 ? [`Sec-WebSocket-Protocol: ${asked[0]}`] : []), '', ''].join('\r\n'));
    socket.setNoDelay(true);
    let initialized = !this.keyFile;
    const page = webSocket(socket, (message) => {
      if (initialized) return;
      try {
        initialized = JSON.parse(message)?.success === true;
      } catch {
        initialized = false;
      }
      if (initialized) this.pages.add(page);
      else page.close();
    }, () => this.pages.delete(page));
    if (this.keyFile) page.send(JSON.stringify({ type: 'InitializeSession', sharedSecret: secret, updates: [] }));
    else this.pages.add(page);
  }

  /** A page's secret decrypted with our key, else the key the app's build made (read as each page comes: a build since may
   *  have made another): base64, as the page keeps it; undefined when it does not decrypt. */
  decrypted(encrypted) {
    try {
      const key = this.own?.privateKey || this.builtKey();
      if (!key) return undefined;
      return crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(encrypted, 'base64')).toString('base64');
    } catch {
      return undefined;
    }
  }

  builtKey() {
    const p = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'))?.parameters;
    if (!p) return undefined;
    const url = (name) => {
      if (!p[name]) throw new Error(`${name} is not there`);
      return Buffer.from(p[name], 'base64').toString('base64url');
    };
    return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'RSA', n: url('modulus'), e: url('exponent'), d: url('d'), p: url('p'), q: url('q'), dp: url('dp'), dq: url('dq'), qi: url('inverseQ') } });
  }

  /** A message to every page connected: how many it reached. */
  send(message) {
    const text = JSON.stringify(message);
    let reached = 0;
    for (const page of this.pages) reached += page.send(text) ? 1 : 0;
    return reached;
  }

  /** An update applied to the app: its pages refreshed as the SDK refreshes them (a Blazor page renders again, any other
   *  reloads). */
  updated() {
    return this.send({ type: 'RefreshBrowser' });
  }

  /** Files changed on disk, told to the pages one change at a time: each the app serves, as its build's map says, a
   *  stylesheet applied in place and anything else reloading them, and a component's scoped CSS bundled again by its
   *  project first; a file unchanged since it was told is passed over. Resolves to what was told: [{ url, reached }]. */
  changed(files) {
    const run = this.telling.then(() => this.tell(files));
    this.telling = run.catch(() => {});
    return run;
  }

  stampChanged(file, goneCounts) {
    let now;
    try {
      const s = fs.statSync(file);
      now = `${s.mtimeMs}:${s.size}`;
    } catch {
      if (!goneCounts) return false;
      now = 'gone';
    }
    const key = file.toLowerCase();
    if (this.told.get(key) === now) return false;
    this.told.set(key, now);
    return true;
  }

  async tell(files) {
    if (this.disposed) return [];
    const assets = this.served();
    const name = path.basename(this.project, path.extname(this.project));
    const urls = [];
    const scoped = []; // projects whose scoped CSS is to be bundled again
    const lost = new Set();
    for (const file of files) {
      if (isScopedCss(file)) {
        const owner = this.projectOf(file);
        if (owner && this.stampChanged(file, true)) {
          if (!scoped.includes(owner)) scoped.push(owner);
          if (!fs.existsSync(file)) lost.add(owner);
        }
      } else {
        const url = this.urlOf(assets, file);
        if (url && this.stampChanged(file, false) && !urls.includes(url)) urls.push(url);
      }
    }
    for (const bundled of scoped) {
      const own = sameFile(bundled, this.project);
      const bundledName = path.basename(bundled, path.extname(bundled));
      const url = own ? `${name}.styles.css` : assets?.bundleUrlOf(bundled);
      if (!url) {
        this.says(t("Hot Reload: {0}'s scoped CSS is not in {1}'s pages, as {1}'s build took in none of it: build {1} again to have it.", bundledName, name), true);
        continue;
      }
      const failed = await this.bundle(bundled, own, lost.has(bundled) ? assets?.bundleFileOf(bundled, own) : undefined);
      if (failed) this.says(t("Hot Reload: {0}'s scoped CSS could not be bundled again: {1}", bundledName, failed), true);
      else urls.push(url);
    }
    const told = [];
    for (const url of urls) {
      const reached = this.send({ type: 'UpdateStaticFile', path: url });
      const css = /\.css$/i.test(url);
      this.says(reached === 0 ? (css ? t('Hot Reload: {0} changed, with no page open to apply it in.', url) : t('Hot Reload: {0} changed, with no page open to reload.', url))
        : css ? tn(reached, 'Hot Reload: {1} applied in 1 page.', 'Hot Reload: {1} applied in {0} pages.', url) : tn(reached, 'Hot Reload: {1} changed: 1 page reloaded.', 'Hot Reload: {1} changed: {0} pages reloaded.', url), false);
      told.push({ url, reached });
    }
    return told;
  }

  /** The app's map of what it serves as its build last wrote it. */
  served() {
    const manifest = path.join(this.intermediate, MANIFEST);
    try {
      const s = fs.statSync(manifest);
      const stamp = `${s.mtimeMs}:${s.size}`;
      if (this.assets?.stamp !== stamp) this.assets = { stamp, read: readAssets(fs.readFileSync(manifest, 'utf8')) };
    } catch {
      // none written: what was read stands
    }
    return this.assets?.read;
  }

  /** The URL the app serves a file at, as its build's map says, else a file come since in its own wwwroot. */
  urlOf(assets, file) {
    const url = assets?.urlOf(file);
    if (url) return url;
    const root = path.join(path.dirname(this.project), 'wwwroot');
    return isUnder(file, root) ? path.relative(root, file).split(path.sep).join('/') : undefined;
  }

  /** The project a file is one of its own of, of the app and those it references, the innermost; none for build output. */
  projectOf(file) {
    let found;
    for (const project of [this.project, ...this.referenced]) {
      const folder = path.dirname(project);
      if (!isUnder(file, folder)) continue;
      const inside = path.relative(folder, file).split(path.sep)[0].toLowerCase();
      if (inside === 'bin' || inside === 'obj') continue;
      if (!found || project.length > found.length) found = project;
    }
    return found;
  }

  /** A project's scoped CSS bundled again by its build's own targets, with no compile: undefined once done, else why not.
   *  Where a sheet of it went, the bundle the app serves is emptied first (the targets write none with no sheet left,
   *  which would keep the last rules); what it held is put back unless the targets ran. */
  bundle(bundled, own, emptied) {
    let held;
    if (emptied) {
      try {
        held = fs.readFileSync(emptied);
        fs.writeFileSync(emptied, '');
      } catch {
        held = undefined;
      }
    }
    const properties = own ? this.build.properties : this.build.properties.filter((p) => !/^-p:TargetFramework=/i.test(p));
    return new Promise((resolve) => {
      execFile('dotnet', ['msbuild', bundled, '-nologo', '-verbosity:quiet', '-target:GenerateComputedBuildStaticWebAssets;ResolveReferencedProjectsStaticWebAssets', ...properties],
        { cwd: path.dirname(bundled), windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
          if (error && held) {
            try {
              fs.writeFileSync(emptied, held);
            } catch {
              // the app holds it: the next bundling writes it whole
            }
          }
          resolve(error ? (`${stdout}${stderr}`.trim() || error.message) : undefined);
        });
    });
  }

  dispose() {
    this.disposed = true;
    for (const page of this.pages) page.close();
    this.pages.clear();
    this.server.close();
  }
}

module.exports = { prepareBrowserRefresh, readAssets, middlewareOf, isScopedCss };
