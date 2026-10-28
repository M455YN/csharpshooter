// The requests of an .http or .rest file, as Visual Studio 2026's HTTP editor reads them: requests apart by ###, each a
// request line (METHOD URL [HTTP/version]), headers up to a blank line and a body to the request's end; file variables
// (@name = value) and {{name}}, the HTTP environment's values (http-client.env.json, and .user beside it overriding), and
// {{$guid}}, {{$randomInt min max}}, {{$timestamp}}, {{$datetime iso8601|rfc1123}}, {{$processEnv NAME}}. Sent with
// Node's fetch. No VS Code in this file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const METHODS = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(\S.*?)(?:\s+HTTP\/[\d.]+)?\s*$/i;
const VARIABLE = /^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/;

/** The file's requests: { line (of the request line), method, url, headers: [[name, value]], body, end } with their text
 *  as written (variables not yet put in), and the file's variables by name with the line each is defined on. */
function parse(text) {
  const lines = text.split(/\r?\n/);
  const variables = new Map();
  const requests = [];
  let block = [];
  const flush = () => {
    const at = block.findIndex(({ text: l }) => METHODS.test(l) || /^\s*https?:\/\//i.test(l));
    if (at >= 0) {
      const first = block[at];
      const m = METHODS.exec(first.text);
      const request = { line: first.line, method: m ? m[1].toUpperCase() : 'GET', url: (m ? m[2] : first.text).trim(), headers: [], body: '', end: block[block.length - 1].line };
      let i = at + 1;
      for (; i < block.length && block[i].text.trim() !== ''; i++) {
        const h = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(block[i].text);
        if (h && !block[i].text.trim().startsWith('#')) request.headers.push([h[1], h[2].trim()]);
      }
      const body = block.slice(i + 1).map((b) => b.text);
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      request.body = body.join('\n');
      requests.push(request);
    }
    block = [];
  };
  lines.forEach((l, line) => {
    if (/^\s*###/.test(l)) return flush();
    const v = VARIABLE.exec(l);
    if (v && !block.some((b) => METHODS.test(b.text))) {
      variables.set(v[1], { value: v[2], line });
      return undefined;
    }
    // A comment line (# or //) before the request line or among the headers; the body keeps its own.
    if (/^\s*(#|\/\/)/.test(l) && !block.some((b) => b.text.trim() === '' && block.some((x) => METHODS.test(x.text)))) return undefined;
    if (!block.length && l.trim() === '') return undefined;
    block.push({ text: l, line });
    return undefined;
  });
  flush();
  return { requests, variables };
}

/** The HTTP environments of the folder holding a file, or the nearest above it (up to `root`): http-client.env.json,
 *  with http-client.env.json.user beside it overriding, by environment name. */
function environments(file, root) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const env = path.join(dir, 'http-client.env.json');
    if (fs.existsSync(env)) {
      const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
      const shared = read(env);
      const user = fs.existsSync(`${env}.user`) ? read(`${env}.user`) : {};
      const all = {};
      for (const name of new Set([...Object.keys(shared), ...Object.keys(user)])) {
        if (name === '$schema' || name === '$shared') continue;
        all[name] = { ...(shared.$shared || {}), ...(shared[name] || {}), ...(user.$shared || {}), ...(user[name] || {}) };
      }
      return { file: env, all };
    }
    if (!root || path.dirname(dir) === dir || path.resolve(dir).toLowerCase() === path.resolve(root).toLowerCase()) return { file: null, all: {} };
  }
}

const DYNAMIC = {
  $guid: () => crypto.randomUUID(),
  $randomInt: (min = '0', max = '1000') => {
    const lo = Number(min);
    const hi = Number(max);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`randomInt: ${min} ${max}`);
    return String(lo + Math.floor(Math.random() * Math.max(1, hi - lo)));
  },
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $datetime: (format = 'iso8601') => (/^rfc1123$/i.test(format) ? new Date().toUTCString() : new Date().toISOString()),
  $localDatetime: (format = 'iso8601') => (/^rfc1123$/i.test(format) ? new Date().toString() : new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace('Z', '')),
  $processEnv: (name) => {
    if (!(name in process.env)) throw new Error(`process env: ${name}`);
    return process.env[name];
  },
};

/** A text with its {{...}} put in, from the file's variables (themselves resolved in turn), then the environment's; an
 *  unknown name is an error naming it (VS's „Zmienna „{0}” nie jest zdefiniowana.”). */
function resolve(text, variables, environment, error, depth = 0) {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expression) => {
    const [name, ...args] = expression.split(/\s+/);
    if (name.startsWith('$')) {
      const fn = DYNAMIC[name];
      if (!fn) throw new Error(error.undefined(name));
      return fn(...args);
    }
    if (variables.has(name) && depth < 10) return resolve(variables.get(name).value, variables, environment, error, depth + 1);
    if (environment && name in environment) return String(environment[name]);
    throw new Error(error.undefined(name));
  });
}

/** One request with everything put in: { method, url, headers, body }; the URL must be absolute. */
function prepare(request, variables, environment, error) {
  const url = resolve(request.url, variables, environment, error);
  try {
    new URL(url);
  } catch {
    throw new Error(error.notAbsolute(url));
  }
  return {
    method: request.method,
    url,
    headers: request.headers.map(([n, v]) => [n, resolve(v, variables, environment, error)]),
    body: request.body ? resolve(request.body, variables, environment, error) : '',
  };
}

/** Sends it: { status, statusText, headers: [[name, value]], body (text), bytes, ms }. */
async function send(prepared, signal) {
  const started = performance.now();
  const response = await fetch(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.body && !/^(GET|HEAD)$/.test(prepared.method) ? prepared.body : undefined,
    redirect: 'follow',
    signal,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: buffer.toString('utf8'),
    bytes: buffer.length,
    ms: performance.now() - started,
  };
}

/** The request and response as text, as VS's Nieprzetworzone tab has them. */
function raw(prepared, response, labels) {
  const request = [`${prepared.method} ${prepared.url}`, ...prepared.headers.map(([n, v]) => `${n}: ${v}`), '', prepared.body].join('\n');
  const answer = [`HTTP ${response.status} ${response.statusText}`, ...response.headers.map(([n, v]) => `${n}: ${v}`), '', response.body].join('\n');
  return `${labels.request}\n${request.trimEnd()}\n\n${labels.response}\n${answer.trimEnd()}\n`;
}

module.exports = { parse, environments, resolve, prepare, send, raw };
