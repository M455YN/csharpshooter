// Each variable's expression, as VS's debugger builds it for a watch: Passenger's evaluateName is right for a frame's locals
// and the fields of `this`, but deeper down it is the member's name alone ("_request" for httpContext._request), which the
// frame does not know. Its DAP messages are followed here (variables a parent expands into, watches), and each child gets
// the parent's expression, cast to the parent's runtime type (a private field of DefaultHttpContext, a variable declared
// HttpContext), then the member or the [index].
const vscode = require('vscode');

const IDENTIFIER = /^@?[A-Za-z_][A-Za-z0-9_]*$/;
// Passenger's groups: the members they hold are the parent's own, or its static ones, or its items (Results View).
const SAME = new Set(['Raw View', 'Non-Public members']);

/** The parent's expression as a value of its runtime type, where C# can name that type. */
function asType(parent) {
  if (!parent.type || /<>|^<|\{|\s\(/.test(parent.type)) return `(${parent.path})`;
  return `((${parent.type})(${parent.path}))`;
}

/** A child's expression from its parent's ({ path, type, staticOf, results }), or null where there is none. */
function childPath(parent, name) {
  if (parent.staticOf) return IDENTIFIER.test(name) ? `${parent.staticOf}.${name}` : null;
  const index = /^\[(\d+)\]$/.exec(name);
  if (index) return parent.results ? `System.Linq.Enumerable.ElementAt(${asType(parent)}, ${index[1]})` : `${asType(parent)}[${index[1]}]`;
  return IDENTIFIER.test(name) ? `${asType(parent)}.${name}` : null;
}

function registerVariablePaths(context) {
  const sessions = new Map(); // session id -> { refs: variablesReference -> node, children: "ref:name" -> path, asked: seq -> request }
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('csharpshooter', {
    createDebugAdapterTracker(session) {
      const s = { refs: new Map(), children: new Map(), asked: new Map() };
      sessions.set(session.id, s);
      return {
        onWillReceiveMessage(m) {
          if (m.type === 'request' && (m.command === 'variables' || m.command === 'evaluate')) s.asked.set(m.seq, m);
        },
        onDidSendMessage(m) {
          if (m.type === 'event' && m.event === 'continued') {
            s.refs.clear();
            s.children.clear();
          }
          if (m.type !== 'response') return;
          const request = s.asked.get(m.request_seq);
          s.asked.delete(m.request_seq);
          if (!request || !m.success) return;
          if (request.command === 'evaluate') {
            if (m.body?.variablesReference) s.refs.set(m.body.variablesReference, { path: request.arguments.expression, type: m.body.type });
            return;
          }
          const parentRef = request.arguments.variablesReference;
          const parent = s.refs.get(parentRef);
          for (const v of m.body?.variables || []) {
            let node;
            if (!parent) node = v.evaluateName ? { path: v.evaluateName, type: v.type } : null; // a scope's: the frame's own
            else if (SAME.has(v.name)) node = { ...parent };
            else if (v.name === 'Static members') node = parent.type && !/<>/.test(parent.type) ? { staticOf: parent.type } : null;
            else if (v.name === 'Results') node = { path: parent.path, type: parent.type, results: true };
            else {
              const path = childPath(parent, v.name);
              node = path ? { path, type: v.type } : null;
            }
            if (node?.path) s.children.set(`${parentRef}:${v.name}`, node.path);
            if (node && v.variablesReference) s.refs.set(v.variablesReference, node);
          }
        },
        onExit: () => sessions.delete(session.id),
      };
    },
  }));
  /** The expression for a variable as the Variables and Watch menus give it ({ container, variable, sessionId }). */
  return (arg) => {
    const s = sessions.get(arg?.sessionId ?? vscode.debug.activeDebugSession?.id);
    if (!s || !arg?.variable) return undefined;
    return s.children.get(`${arg.container?.variablesReference}:${arg.variable.name}`) ?? s.refs.get(arg.variable.variablesReference)?.path;
  };
}

module.exports = { registerVariablePaths, childPath };
