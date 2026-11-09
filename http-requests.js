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

// ---- OpenAPI, as Passenger's Endpoints window reads it (src/Passenger.App/Endpoints at 9954e4b): an app's document (3.0,
// 3.1 or Swagger 2.0) read from the app on this machine or from the file its build writes, its operations written as
// requests, and a response's JSON held to its operation's schema. ----

const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** The paths an app serves its document at by default: MapOpenApi's, then Swashbuckle's and NSwag's. */
const OPENAPI_PATHS = ['/openapi/v1.json', '/swagger/v1/swagger.json'];

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** What a local reference (#/components/schemas/Item, #/definitions/Item) names in the document; undefined for any other. */
function pointer(root, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined;
  let at = root;
  for (const part of reference.slice(2).split('/')) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(at) && !Array.isArray(at)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

/** A schema with its $ref followed (a chain of them too), and the last reference followed, by which it is known. */
function deref(document, written) {
  let schema = written;
  let key;
  for (let i = 0; i < 32 && isObject(schema) && typeof schema.$ref === 'string'; i++) {
    const found = pointer(document.root, schema.$ref);
    if (found === undefined) break;
    key = schema.$ref;
    schema = found;
  }
  return { schema, key };
}

/** The schema of a request's or response's JSON body: its application/json content's, else the first JSON one's. */
function jsonSchemaOf(holder) {
  const content = Object.entries(isObject(holder?.content) ? holder.content : {});
  const found = content.find(([type]) => /^application\/json/i.test(type)) || content.find(([type]) => /json/i.test(type));
  return isObject(found?.[1]) ? found[1].schema : undefined;
}

/** An app's OpenAPI document read from its JSON text: { root, title, operations: [{ method, path, operationId, summary,
 *  parameters: [{ name, in, schema, required }], requestSchema, responses: { status: schema } }] }; null for text that is no
 *  document (no openapi or swagger, no paths). */
function openApiDocument(text) {
  let root;
  try {
    root = typeof text === 'string' ? JSON.parse(text.replace(/^\uFEFF/, '')) : text;
  } catch {
    return null;
  }
  if (!isObject(root) || !(root.openapi || root.swagger) || !isObject(root.paths)) return null;
  const document = { root, title: root.info?.title, operations: [] };
  for (const [route, item] of Object.entries(root.paths)) {
    if (!isObject(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const [method, operation] of Object.entries(item)) {
      if (!OPERATION_METHODS.includes(method.toLowerCase()) || !isObject(operation)) continue;
      const parameters = [];
      let bodyIn2;
      for (const written of [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
        const parameter = deref(document, written).schema;
        if (!isObject(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue;
        if (parameter.in === 'body') {
          bodyIn2 = parameter.schema;
          continue;
        }
        const was = parameters.findIndex((p) => p.name === parameter.name && p.in === parameter.in);
        if (was >= 0) parameters.splice(was, 1);
        parameters.push({ name: parameter.name, in: parameter.in, schema: parameter.schema || (parameter.type ? parameter : undefined), required: parameter.required === true || parameter.in === 'path' });
      }
      const responses = {};
      for (const [status, written] of Object.entries(isObject(operation.responses) ? operation.responses : {})) {
        const response = deref(document, written).schema;
        const schema = jsonSchemaOf(response) || response?.schema;
        if (schema !== undefined) responses[status] = schema;
      }
      document.operations.push({
        method: method.toUpperCase(), path: route, operationId: typeof operation.operationId === 'string' ? operation.operationId : undefined,
        summary: typeof operation.summary === 'string' ? operation.summary : undefined, parameters,
        requestSchema: jsonSchemaOf(deref(document, operation.requestBody).schema) || bodyIn2, responses,
      });
    }
  }
  return document;
}

const segmentsOf = (route) => route.split(/[?#]/)[0].split('/').filter(Boolean);

/** The operation a request calls: of its method, its path fitting the operation's route segment by segment, a {name} taking
 *  what lies there and a request's {{variable}} anything; of several, the one with fewer parameters. */
function operationFor(document, method, route) {
  const asked = segmentsOf(route).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const fits = (operation) => {
    const template = segmentsOf(operation.path);
    return template.length === asked.length && template.every((t, i) => asked[i].includes('{{')
      || new RegExp(`^${t.split(/(\{[^{}]+\})/).map((p) => (/^\{[^{}]+\}$/.test(p) ? '.+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 'i').test(asked[i]));
  };
  return document.operations.filter((o) => o.method === method.toUpperCase() && fits(o))
    .sort((a, b) => (a.path.match(/\{/g) || []).length - (b.path.match(/\{/g) || []).length)[0];
}

/** The schema a response of a status is held to: its own, its class's (2XX), else default's; undefined where none. */
function responseSchema(operation, status) {
  const code = String(status);
  return [code, `${code[0]}XX`, `${code[0]}xx`, 'default'].map((c) => operation.responses[c]).find((s) => s !== undefined);
}

/** The types a schema allows: its type, one or a list, with null where 3.0's nullable says. */
function typesOf(schema) {
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t) => typeof t === 'string') : [];
  if (types.length && schema.nullable === true && !types.includes('null')) types.push('null');
  return types;
}

const marked = (document, written, mark) => {
  const { schema } = deref(document, written);
  return written?.[mark] === true || schema?.[mark] === true;
};

/** A value made from a schema, as a request's body starts: its example or default, else its first enum member (where the
 *  schema says it is a number, as System.Text.Json reads an enum without JsonStringEnumConverter, that member's number),
 *  else what its allOf and first anyOf/oneOf option make, else of its first type (an object's members but the read-only
 *  ones, an array of one item, a string by its format, 0, false). A schema met again inside itself is null there. */
function sampleOf(document, written, depth = 0, referred = new Set()) {
  const reference = isObject(written) && typeof written.$ref === 'string' ? written.$ref : undefined;
  if (depth > 8 || (reference && referred.has(reference))) return undefined;
  if (reference) referred.add(reference);
  try {
    const { schema } = deref(document, written);
    if (!isObject(schema)) return undefined;
    if ('example' in schema) return schema.example;
    if ('default' in schema) return schema.default;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    const types = typesOf(schema);
    if (Array.isArray(schema.enum) && schema.enum.length) {
      const first = schema.enum.find((v) => v !== null) ?? schema.enum[0];
      const numeric = types.includes('integer') || types.includes('number');
      if (numeric && typeof first === 'string' && !types.includes('string')) return /^\s*-?\d+(\.\d+)?\s*$/.test(first) ? Number(first) : 0;
      return first;
    }
    const parts = [...(Array.isArray(schema.allOf) ? schema.allOf : []), ...['anyOf', 'oneOf'].flatMap((c) => (Array.isArray(schema[c]) ? schema[c].slice(0, 1) : []))];
    if (parts.length) {
      let merged;
      let value;
      for (const part of parts) {
        const made = sampleOf(document, part, depth + 1, referred);
        if (isObject(made)) merged = { ...(merged || {}), ...made };
        else if (made !== undefined) value = made;
      }
      for (const [name, member] of Object.entries(isObject(schema.properties) ? schema.properties : {})) {
        if (!marked(document, member, 'readOnly')) (merged ||= {})[name] = sampleOf(document, member, depth + 1, referred) ?? null;
      }
      if (merged || value !== undefined) return merged ?? value;
    }
    const kind = ['object', 'array', 'integer', 'number', 'boolean', 'string'].find((t) => types.includes(t)) || (isObject(schema.properties) ? 'object' : undefined);
    switch (kind) {
      case 'object': {
        const made = {};
        for (const [name, member] of Object.entries(isObject(schema.properties) ? schema.properties : {})) {
          if (!marked(document, member, 'readOnly')) made[name] = sampleOf(document, member, depth + 1, referred) ?? null;
        }
        return made;
      }
      case 'array': {
        const item = schema.items === undefined ? undefined : sampleOf(document, schema.items, depth + 1, referred);
        return item === undefined ? [] : [item];
      }
      case 'integer':
      case 'number':
        return 0;
      case 'boolean':
        return false;
      case 'string':
        return { 'date-time': '2000-01-01T00:00:00Z', date: '2000-01-01', time: '00:00:00', uuid: '00000000-0000-0000-0000-000000000000', email: 'name@example.com', uri: 'https://example.com/' }[schema.format] || 'string';
      default:
        return undefined;
    }
  } finally {
    if (reference) referred.delete(reference);
  }
}

/** The path a request's URL asks for, after its leading {{variable}} or scheme://host. */
function routePath(url) {
  const rest = url.trim();
  if (rest.startsWith('{{')) {
    const close = rest.indexOf('}}');
    return close < 0 ? undefined : `/${rest.slice(close + 2).replace(/^\/+/, '')}`;
  }
  const scheme = rest.indexOf('://');
  if (scheme > 0) {
    const slash = rest.indexOf('/', scheme + 3);
    return slash < 0 ? '/' : rest.slice(slash);
  }
  return rest.startsWith('/') ? rest : undefined;
}

/** A parameter's or form field's value as a URL writes it: a string as it is, an array's first item, else its JSON. */
const textOf = (value) => (Array.isArray(value) ? textOf(value[0]) : typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));

/** The requests an app's document makes, to go after `existing` (the .http file's text, '' for a new one), for each
 *  operation none of its requests calls yet: a "# OpenAPI: operationId (summary)" line, a variable for each path and
 *  required query parameter the file does not set yet, the method and {{host}}'s route, Accept and each required header,
 *  and a JSON body made from its request schema. `address` sets @host first where the file does not, and is given.
 *  { text, operations }: what to append, and the operations it writes. */
function openApiRequests(document, existing = '', host = 'baseUrl', address) {
  const { requests, variables } = parse(existing);
  const set = new Set(variables.keys());
  const operations = document.operations.filter((operation) => !requests.some((r) => r.method === operation.method
    && routePath(r.url) !== undefined && operationFor(document, operation.method, routePath(r.url)) === operation));
  const lines = [];
  if (existing.trim() && !/^\s*###[^\n]*\s*$/.test(existing.trimEnd().split(/\r?\n/).pop() || '')) lines.push('', '###', '');
  else if (existing && !existing.endsWith('\n')) lines.push('');
  if (address && !set.has(host)) {
    lines.push(`@${host} = ${address}`, '');
    set.add(host);
  }
  const made = new Map(); // what this writing set each variable to: another operation's parameter of the name but another value has its own
  for (const operation of operations) {
    lines.push(`# OpenAPI: ${operation.operationId || `${operation.method} ${operation.path}`}${operation.summary ? ` (${operation.summary})` : ''}`);
    const named = operation.parameters.filter((p) => p.in === 'path' || (p.in === 'query' && p.required));
    const variableOf = {};
    for (const parameter of named) {
      const value = parameter.schema === undefined ? parameter.name : textOf(sampleOf(document, parameter.schema));
      let variable = parameter.name.replace(/[^\w.-]/g, '_');
      if (made.has(variable) && made.get(variable) !== value) {
        const stem = `${operation.operationId || operation.method.toLowerCase()}_${variable}`;
        variable = stem;
        for (let more = 2; set.has(variable) && made.get(variable) !== value; more++) variable = `${stem}${more}`;
      }
      variableOf[parameter.name] = variable;
      if (!set.has(variable)) {
        set.add(variable);
        made.set(variable, value);
        lines.push(`@${variable} = ${value}`);
      }
    }
    const route = operation.path.replace(/\{([^{}]+)\}/g, (whole, name) => `{{${variableOf[name] || name}}}`);
    const query = named.filter((p) => p.in === 'query').map((p) => `${encodeURIComponent(p.name)}={{${variableOf[p.name]}}}`);
    lines.push(`${operation.method} {{${host}}}${route}${query.length ? `?${query.join('&')}` : ''}`, 'Accept: application/json');
    for (const header of operation.parameters.filter((p) => p.in === 'header' && p.required)) {
      lines.push(`${header.name}: ${header.schema === undefined ? header.name : textOf(sampleOf(document, header.schema))}`);
    }
    if (operation.requestSchema !== undefined) {
      lines.push('Content-Type: application/json', '', JSON.stringify(sampleOf(document, operation.requestSchema) ?? {}, null, 2));
    }
    lines.push('', '###', '');
  }
  return { text: operations.length ? lines.join('\n') : '', operations };
}

/** What a schema check says, in English; the editor gives its own (Polish) texts. */
const SCHEMA_SAYS = {
  missing: () => 'is missing, though its schema requires it',
  type: (expected, got) => `${expected} was expected, not ${got}`,
  notListed: (got, allowed) => `${got} is not one of ${allowed}`,
  pattern: (got, pattern) => `${got} does not match its pattern ${pattern}`,
  extra: () => 'is not a member its schema has',
  nothing: () => 'nothing is allowed here',
  none: (choice, count) => `matches none of the ${count} options of its schema's ${choice}`,
  many: (one, other) => `matches both ${one} and ${other} of its schema's oneOf, which allows exactly one`,
  option: (number) => `option ${number}`,
};

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value);
const described = (value) => (value !== null && typeof value === 'object' ? kindOf(value) : (() => { const s = JSON.stringify(value); return s.length > 42 ? `${s.slice(0, 41)}…` : s; })());
const escapedName = (name) => name.replace(/~/g, '~0').replace(/\//g, '~1');

/** Where a JSON value breaks a schema of the document, in the order met: [{ at (a JSON pointer, / for the whole), said }];
 *  none where it keeps to it. Read: type (with 3.0's nullable and 3.1's lists), enum, a string's pattern, an object's
 *  required (a writeOnly member kept to requests), properties and additionalProperties, an array's items, allOf, anyOf and
 *  oneOf (exactly one). Each schema is judged once per place in the value, so a schema that refers to itself ends. */
function checkSchema(document, schema, value, says = SCHEMA_SAYS) {
  const breaks = [];
  const walked = new Set();
  const fitting = new Map();
  const most = 50;
  const deepest = 48;
  const broken = (list, at, said) => {
    if (list && list.length < most) list.push({ at: at || '/', said });
    return false;
  };
  const resolved = (written, place) => {
    const { schema: s, key } = deref(document, written);
    return { s, key: key || place };
  };
  const walk = (written, place, v, at, depth) => {
    const { s, key } = resolved(written, place);
    const id = `${key}\n${at}`;
    if (depth > deepest || breaks.length >= most || walked.has(id)) return;
    walked.add(id);
    judge(s, key, v, at, depth, breaks);
  };
  const fits = (written, place, v, at, depth) => {
    if (depth > deepest) return true;
    const { s, key } = resolved(written, place);
    const id = `${key}\n${at}`;
    if (fitting.has(id)) return fitting.get(id);
    fitting.set(id, true); // asked again before it is answered, a schema that refers to itself holds nothing more
    const kept = judge(s, key, v, at, depth, null);
    fitting.set(id, kept);
    return kept;
  };
  const down = (written, place, v, at, depth, list) => {
    if (!list) return fits(written, place, v, at, depth);
    walk(written, place, v, at, depth);
    return true;
  };
  const optionName = (options, i) => (typeof options[i]?.$ref === 'string' ? options[i].$ref.slice(options[i].$ref.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~') : says.option(i + 1));
  function judge(s, key, v, at, depth, list) {
    if (s === false) return broken(list, at, says.nothing());
    if (!isObject(s)) return true;
    let kept = true;
    (Array.isArray(s.allOf) ? s.allOf : []).forEach((part, i) => {
      if (kept || list) kept = down(part, `${key}/allOf/${i}`, v, at, depth, list) && kept;
    });
    if (!kept && !list) return false;
    for (const choice of ['anyOf', 'oneOf']) {
      const options = Array.isArray(s[choice]) ? s[choice] : [];
      if (!options.length) continue;
      const held = [];
      for (let i = 0; i < options.length && held.length < (choice === 'oneOf' ? 2 : 1); i++) if (fits(options[i], `${key}/${choice}/${i}`, v, at, depth)) held.push(i);
      if (held.length === 0) return broken(list, at, says.none(choice, options.length));
      if (held.length > 1) return broken(list, at, says.many(optionName(options, held[0]), optionName(options, held[1])));
    }
    const types = typesOf(s);
    const kind = kindOf(v);
    if (types.length && !types.some((t) => t === kind || (t === 'number' && kind === 'integer'))) {
      return broken(list, at, says.type([...types].sort((a, b) => (a === 'null') - (b === 'null')).join(' | '), described(v)));
    }
    if (Array.isArray(s.enum) && s.enum.length && !s.enum.some((item) => JSON.stringify(item) === JSON.stringify(v))) {
      return broken(list, at, says.notListed(described(v), s.enum.slice(0, 8).map((x) => JSON.stringify(x)).join(', ') + (s.enum.length > 8 ? ', …' : '')));
    }
    if (kind === 'string' && typeof s.pattern === 'string') {
      let matches = true;
      try { matches = new RegExp(s.pattern, 'u').test(v); } catch { /* a pattern JavaScript does not read: passed over */ }
      if (!matches) return broken(list, at, says.pattern(described(v), s.pattern));
    }
    if (kind === 'object') {
      for (const name of Array.isArray(s.required) ? s.required : []) {
        if (typeof name === 'string' && !Object.prototype.hasOwnProperty.call(v, name) && !marked(document, s.properties?.[name], 'writeOnly')) {
          kept = broken(list, `${at}/${escapedName(name)}`, says.missing());
          if (!list) return false;
        }
      }
      const properties = isObject(s.properties) ? s.properties : {};
      for (const [name, member] of Object.entries(v)) {
        const place = `${at}/${escapedName(name)}`;
        const held = Object.prototype.hasOwnProperty.call(properties, name) ? down(properties[name], `${key}/properties/${escapedName(name)}`, member, place, depth + 1, list)
          : s.additionalProperties === false ? broken(list, place, says.extra())
            : isObject(s.additionalProperties) ? down(s.additionalProperties, `${key}/additionalProperties`, member, place, depth + 1, list) : true;
        if (!held && !list) return false;
        kept = kept && held;
      }
    }
    if (kind === 'array' && s.items !== undefined && !Array.isArray(s.items)) {
      for (let i = 0; i < v.length; i++) if (!down(s.items, `${key}/items`, v[i], `${at}/${i}`, depth + 1, list) && !list) return false;
    }
    return kept;
  }
  walk(schema, '#', value, '', 0);
  return breaks;
}

/** A response held to its operation's schema in the document: { operation ("GET /items/{id}"), breaks }; null where the
 *  document has no operation for the request or no JSON schema for the status, or the body is no JSON. */
function checkResponse(document, method, url, response, says) {
  const type = response.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] || '';
  if (!/json/i.test(type) || !response.body) return null;
  let route;
  try {
    route = new URL(url).pathname;
  } catch {
    return null;
  }
  const operation = operationFor(document, method, route);
  const schema = operation && responseSchema(operation, response.status);
  if (schema === undefined) return null;
  let value;
  try {
    value = JSON.parse(response.body);
  } catch {
    return null;
  }
  return { operation: `${operation.method} ${operation.path}`, breaks: checkSchema(document, schema, value, says) };
}

/** Whether an address is this machine's loopback, the only place a document is asked of. */
const onThisMachine = (url) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase()) || url.hostname.toLowerCase().endsWith('.localhost');

/** The document the app at an address serves, at its own paths first, then the defaults; each redirect followed only while
 *  it stays with the app (its origin, or its own move from http to https on the same host). { document, url } or null. */
async function openApiFromApp(address, mapped = [], timeout = 10000) {
  let origin;
  try {
    origin = new URL(address);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(origin.protocol) || !onThisMachine(origin)) return null;
  for (const route of [...new Set([...mapped, ...OPENAPI_PATHS])]) {
    try {
      let url = new URL(route, origin.origin);
      if (url.origin !== origin.origin) continue;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const answer = await fetch(url, { redirect: 'manual', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
        const location = answer.status >= 300 && answer.status < 400 && answer.headers.get('location');
        if (location) {
          const next = new URL(location, url);
          if (next.origin !== url.origin && !(url.protocol === 'http:' && next.protocol === 'https:' && next.hostname === url.hostname)) break;
          url = next;
          continue;
        }
        const document = answer.ok ? openApiDocument(await answer.text()) : null;
        if (document) return { document, url: url.href };
        break;
      }
    } catch {
      // the app is not up, or serves nothing there: the next path
    }
  }
  return null;
}

/** The paths a project's code gives MapOpenApi (MapOpenApi("/docs/{documentName}.json")), v1 as the document's name. */
function mappedOpenApiPaths(texts) {
  const found = texts.flatMap((text) => [...text.matchAll(/\bMapOpenApi\s*\(\s*(?:pattern\s*:\s*)?"([^"]+)"/g)].map((m) => m[1].replace('{documentName}', 'v1')));
  return [...new Set(found.map((p) => (p.startsWith('/') ? p : `/${p}`)))];
}

/** The document a project's build wrote (Microsoft.Extensions.ApiDescription.Server's GetDocument): {project}.json, else the
 *  first {project}_*.json, in its OpenApiDocumentsDirectory, else in obj. { document, file } or null. */
function openApiFromBuild(project) {
  const dir = path.dirname(project);
  const name = path.basename(project, path.extname(project));
  let text = '';
  try {
    text = fs.readFileSync(project, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  } catch {
    // no project: obj alone
  }
  const set = /<OpenApiDocumentsDirectory>([^<]+)</.exec(text)?.[1]?.trim().replace(/\$\(MSBuildProjectDirectory\)/gi, dir).replace(/[\\/]/g, path.sep);
  for (const folder of [set && path.resolve(dir, set), path.join(dir, 'obj')].filter(Boolean)) {
    let files;
    try {
      files = fs.readdirSync(folder);
    } catch {
      continue;
    }
    const lower = name.toLowerCase();
    const named = files.filter((f) => { const stem = f.toLowerCase().replace(/\.json$/, ''); return f.toLowerCase().endsWith('.json') && (stem === lower || stem.startsWith(`${lower}_`)); })
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const file of named) {
      const document = openApiDocument(fs.readFileSync(path.join(folder, file), 'utf8'));
      if (document) return { document, file: path.join(folder, file) };
    }
  }
  return null;
}

/** The URLs a project's launch profiles (Properties/launchSettings.json) start it at, http first, as VS's .http template's
 *  @{Project}_HostAddress takes it. */
function launchUrls(project) {
  try {
    const text = fs.readFileSync(path.join(path.dirname(project), 'Properties', 'launchSettings.json'), 'utf8');
    const settings = JSON.parse(text.replace(/^\uFEFF/, '').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || '').replace(/,(\s*[}\]])/g, '$1'));
    const urls = Object.values(settings.profiles || {}).filter((p) => p.commandName === 'Project').flatMap((p) => String(p.applicationUrl || '').split(';'));
    const iis = settings.iisSettings?.iisExpress;
    if (iis?.applicationUrl) urls.push(iis.applicationUrl);
    return [...new Set(urls.map((u) => u.trim().replace(/\/$/, '')).filter(Boolean))].sort((a, b) => a.startsWith('https:') - b.startsWith('https:'));
  } catch {
    return [];
  }
}

module.exports = {
  parse, environments, resolve, prepare, send, raw,
  OPENAPI_PATHS, openApiDocument, operationFor, responseSchema, sampleOf, routePath, openApiRequests, checkSchema, checkResponse,
  openApiFromApp, mappedOpenApiPaths, openApiFromBuild, launchUrls,
};
