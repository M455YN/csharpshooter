// SqlClient connection strings as the Connect dialog's fields, and back, as SSMS's connection dialog reads and writes
// them: its keys and their synonyms, values quoted where SqlClient needs it, the password left where it is unless given.
const os = require('os');

const KEYS = {
  server: ['data source', 'server', 'address', 'addr', 'network address'],
  database: ['initial catalog', 'database'],
  user: ['user id', 'uid', 'user'],
  password: ['password', 'pwd'],
  integrated: ['integrated security', 'trusted_connection'],
  authentication: ['authentication'],
  encrypt: ['encrypt'],
  trust: ['trust server certificate', 'trustservercertificate'],
  hostName: ['host name in certificate', 'hostnameincertificate'],
  application: ['application name', 'app'],
};

/** A connection string's key=value pairs in order, keys as written (quoted values may hold ';' and doubled quotes). */
function parse(text) {
  const out = [];
  for (const m of (text || '').matchAll(/\s*([^=;]+?)\s*=\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|[^;]*)\s*(?:;|$)/g)) {
    const raw = m[2].trim();
    const value = /^"/.test(raw) ? raw.slice(1, -1).replace(/""/g, '"') : /^'/.test(raw) ? raw.slice(1, -1).replace(/''/g, "'") : raw;
    out.push([m[1], value]);
  }
  return out;
}

const quote = (value) => (/[;'"=]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const format = (pairs) => pairs.map(([k, v]) => `${k}=${quote(String(v))}`).join(';');

function get(pairs, names) {
  return pairs.find(([k]) => names.includes(k.toLowerCase()))?.[1];
}

function set(pairs, names, value) {
  const at = pairs.findIndex(([k]) => names.includes(k.toLowerCase()));
  const rest = pairs.filter(([k], i) => i === at || !names.includes(k.toLowerCase()));
  if (value === undefined || value === null || value === '') return rest.filter(([k]) => !names.includes(k.toLowerCase()));
  if (at < 0) return [...rest, [names[0].replace(/\b\w/g, (c) => c.toUpperCase()), value]];
  return rest.map((p) => (names.includes(p[0].toLowerCase()) ? [p[0], value] : p));
}

const isTrue = (v) => /^(true|yes|sspi)$/i.test(v || '');
const encryptOf = (v) => (/^strict$/i.test(v || '') ? 'Strict' : v === undefined || isTrue(v) || /^mandatory$/i.test(v) ? 'Mandatory' : 'Optional');

/** The dialog's fields of a connection string (SqlClient's defaults where a key is left out: Encrypt is Mandatory). */
function fieldsOf(text) {
  const pairs = parse(text);
  const authentication = get(pairs, KEYS.authentication);
  return {
    server: get(pairs, KEYS.server) || '',
    authentication: isTrue(get(pairs, KEYS.integrated)) ? 'Integrated' : authentication && !/^sqlpassword$/i.test(authentication) ? authentication : 'SqlLogin',
    user: get(pairs, KEYS.user) || '',
    database: get(pairs, KEYS.database) || '',
    encrypt: encryptOf(get(pairs, KEYS.encrypt)),
    trustServerCertificate: isTrue(get(pairs, KEYS.trust)),
    hostNameInCertificate: get(pairs, KEYS.hostName) || '',
    hasPassword: !!get(pairs, KEYS.password),
  };
}

/** A connection string of the fields, on top of base's other keys (MARS, timeouts...). The password stays as base has
 *  it when none is given. */
function build(base, fields, password) {
  let pairs = parse(base);
  pairs = set(pairs, KEYS.server, fields.server);
  pairs = set(pairs, KEYS.database, fields.database);
  if (fields.authentication === 'Integrated') {
    pairs = set(pairs, KEYS.integrated, 'True');
    pairs = set(pairs, KEYS.user, undefined);
    pairs = set(pairs, KEYS.password, undefined);
    pairs = set(pairs, KEYS.authentication, undefined);
  } else {
    pairs = set(pairs, KEYS.integrated, undefined);
    pairs = set(pairs, KEYS.authentication, fields.authentication === 'SqlLogin' ? undefined : fields.authentication);
    pairs = set(pairs, KEYS.user, fields.user);
    if (password !== undefined) pairs = set(pairs, KEYS.password, password);
  }
  pairs = set(pairs, KEYS.encrypt, { Mandatory: 'True', Optional: 'False', Strict: 'Strict' }[fields.encrypt] || 'True');
  pairs = set(pairs, KEYS.trust, fields.trustServerCertificate ? 'True' : 'False');
  pairs = set(pairs, KEYS.hostName, fields.hostNameInCertificate);
  pairs = set(pairs, KEYS.application, 'CSharpShooter');
  return format(pairs);
}

/** The connection string with its password hidden, for the dialog's Connection String tab. */
function masked(text) {
  return format(parse(text).map(([k, v]) => (KEYS.password.includes(k.toLowerCase()) ? [k, '********'] : [k, v])));
}

/** The same connection on another database, or trusting the server's certificate. */
function withChange(text, change) {
  let pairs = parse(text);
  if (change.database !== undefined) pairs = set(pairs, KEYS.database, change.database);
  if (change.trustServerCertificate) pairs = set(pairs, KEYS.trust, 'True');
  return format(pairs);
}

/** The login SSMS shows for a connection: DOMAIN\user for Windows authentication. */
const windowsUser = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username);

/** Server, login and database, as the status bar and the lists show a connection: never its password. */
function describe(text) {
  const f = fieldsOf(text);
  return { server: f.server, database: f.database, user: f.authentication === 'Integrated' ? windowsUser() : f.user };
}

module.exports = { parse, fieldsOf, build, masked, withChange, describe, windowsUser };
