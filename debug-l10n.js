// Passenger's messages in the UI's language: the debug adapter runs here, inline, and the texts it sends that VS Code
// shows (failed requests, breakpoints' messages, the Debug Console's lines, failed evaluations, data breakpoints, a data
// breakpoint's stop) are matched against its English texts below, {n} holding what it filled in, and given through t().
const cp = require('child_process');
const vscode = require('vscode');
const { t, n_, language } = require('./l10n');

const texts = [
  // Launch and attach.
  n_('A process is already being debugged, you must terminate/detach first.'),
  n_('Missing process ID'),
  n_('Missing program path'),
  n_('Could not start {0}: {1}'),
  n_('Could not attach to process {0}: {1}'),
  n_('Could not take hold of process {0} as it started: {1}'),
  n_('{0} (the program had ended, with exit code {1})'),
  n_('Failed to launch: {0}'),
  n_('Failed to attach: {0}'),
  n_('There is no process {0} to attach to'),
  n_('Invalid console type: \'{0}\''),
  n_('The client could not start {0} in its terminal: {1}'),
  n_('The client did not start {0} in its terminal within {1} s'),
  n_('the client cannot start a program in a terminal ({0}); use internalConsole'),
  n_('runInTerminal returned no process ID; use internalConsole, or a client that returns one.'),
  n_('it ended before its runtime told the debugger it had started'),
  n_('it ended before the debugger could take hold of it'),
  n_('it is not a .NET program the debugger can reach: no runtime in it answered, and it opened no diagnostic port within 10 s'),
  n_('the session ended before its runtime told the debugger it had started'),
  n_('the session ended before the debugger could take hold of it'),
  n_('dbgshim could not take hold of process {0}\'s runtime: {1}'),
  n_('dbgshim could not watch for its runtime to start: {0}'),
  n_('Request \'{0}\' is not supported.'),
  // Breakpoints.
  n_('The breakpoint will not currently be hit. No symbols have been loaded for this document.'),
  n_('The breakpoint will not currently be hit. No matching function has been loaded.'),
  n_('The breakpoint will not be hit: the method is marked [DebuggerStepThrough], [DebuggerNonUserCode] or [DebuggerHidden], which Just My Code passes over.'),
  n_('Breakpoint has not been processed by the debugger.'),
  n_('Error binding breakpoint: {0}'),
  n_('Error binding function breakpoint: {0}'),
  n_('Lambda expressions are not supported in breakpoint conditions.'),
  n_('The hit count "{0}" is not one the debugger can read: a hit count is a number from 1, alone or after == (equal to), > (greater than), >= (greater than or equal to), < (less than), <= (less than or equal to) or % (multiple of).'),
  n_('The condition \'{0}\' could not be evaluated, so the breakpoint stopped: {1}'),
  n_('The condition \'{0}\' could not be evaluated, so the breakpoint on {1} stopped: {2}'),
  n_('The condition \'{0}\' could not be evaluated, so the data breakpoint on {1} stopped: {2}'),
  n_('Breakpoint reached at {0}:{1}'),
  n_('Exception breakpoint reached: {0}'),
  // Data breakpoints.
  n_('Data breakpoint reached: {0} is changed from {1} to {2}'),
  n_('Previous Value: {0}, New Value: {1}'),
  n_('Data breakpoints are only available on Windows x64, the one system whose .NET runtime supports them; this is {0} on {1}'),
  n_('Nothing is being debugged'),
  n_('The program is running: a data breakpoint is set on a value where it is paused'),
  n_('This value is from an earlier stop, and the program has run on since'),
  n_('A data breakpoint watches a field or property of an object, or an element of an array, and this is neither'),
  n_('Static fields and properties are not supported'),
  n_('Fields and properties of structs are not supported'),
  n_('These are the members its debugger view shows; its own are under Raw View'),
  n_('The debugger could not read {0}: {1}'),
  n_('The breakpoint cannot be set. Data breakpoints for properties with custom setters are not supported.'),
  n_('The breakpoint cannot be set. The property doesn\'t have a backing field.'),
  n_('The breakpoint cannot be set. \'{0}\' cannot be found on the managed heap and cannot be tracked.'),
  n_('The breakpoint cannot be set. The hardware does not support monitoring of the requested number of bytes ({0}). The maximum number of bytes to track is {1}.'),
  n_('The breakpoint cannot be set. The hardware watches {0} bytes only at an address that is a multiple of {0}, which \'{1}\' is not at.'),
  n_('The breakpoint cannot be set. The maximum number of data breakpoints for the current architecture is {0}.'),
  n_('The data it watched is from another session'),
  n_('The object {0} was in has been collected'),
  n_('The program\'s runtime cannot pin the object to watch it: data breakpoints need .NET 5 or later'),
  n_('A data breakpoint here stops at a write, not a {0}'),
  // Running, stepping, frames.
  n_('The program is running, so it cannot step'),
  n_('The program is running, so its threads\' frames and values cannot be read until it stops'),
  n_('A step operation is already in progress'),
  n_('The program has no thread {0} to step: it has ended'),
  n_('The program cannot go on from there ({0})'),
  n_('That call is not one the program can step into from where it is now'),
  n_('The thread is no longer in the frame the call was listed for'),
  n_('The thread is not stopped in managed code'),
  n_('The thread is stopped outside managed code, so its exception cannot be read'),
  n_('No current exception is available'),
  n_('No current exception on thread'),
  n_('No call has returned a value since the last step'),
  n_('The code is in a module whose metadata the debugger could not read'),
  // Evaluation.
  n_('error: {0}'),
  n_('Frame ID is required for evaluation'),
  n_('Expression evaluation is not supported for synthetic async caller frames'),
  n_('Not evaluated: the program went on'),
  n_('The program went on before the evaluation ended'),
  n_('The expression took too long to evaluate: it was stopped after {0} s'),
  n_('The evaluation took longer than {0} s and was stopped: it may wait on another thread, which stays paused while it runs'),
  n_('The evaluation took longer than {0} s and could not be stopped, as {1}: it runs on in the program until it returns, the program paused meanwhile'),
  n_('the abort asked of it has not taken'),
  n_('Implicit evaluation is disabled: an evaluation took longer than {0} s. It is enabled again once the program runs on'),
  n_('Evaluation threw {0}: {1}'),
  n_('Expanding will force enumeration of the object'),
  n_('This is not an EF Core query'),
  n_('This EF Core has no ToQueryString(), which came with EF Core 5'),
  n_('ToQueryString() returned nothing'),
  n_('The query is no longer there to read'),
];

// Each text as a whole-string pattern, the most literal first, so a text with fewer holes wins over one that would
// swallow it; a hole repeated in a text must hold the same thing.
const patterns = texts
  .map((text) => {
    const seen = new Set();
    const source = text.split(/(\{\d\})/).map((part) => {
      const hole = /^\{(\d)\}$/.exec(part);
      if (!hole) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (seen.has(hole[1])) return `\\k<h${hole[1]}>`;
      seen.add(hole[1]);
      return `(?<h${hole[1]}>[\\s\\S]*?)`;
    }).join('');
    return { text, re: new RegExp(`^${source}$`), literal: text.replace(/\{\d\}/g, '').length };
  })
  .sort((a, b) => b.literal - a.literal);

/** A message of Passenger's in the UI's language, what it filled in translated as well (an error inside an error). */
function translate(message) {
  if (typeof message !== 'string' || !message) return message;
  const end = /\s*$/.exec(message)[0];
  const body = message.slice(0, message.length - end.length);
  for (const { text, re } of patterns) {
    const m = re.exec(body);
    if (!m) continue;
    const args = [];
    for (const [name, value] of Object.entries(m.groups || {})) args[Number(name.slice(1))] = translate(value);
    return t(text, ...args) + end;
  }
  return message;
}

const failed = (hint) => (hint?.attributes || []).includes('failedEvaluation');

/** Translates in place the texts of one DAP message from the adapter that VS Code shows. */
function translateMessage(m) {
  const body = m.body;
  if (m.type === 'response') {
    if (m.success === false) {
      m.message = translate(m.message);
      if (body?.error?.format) body.error.format = translate(body.error.format);
    }
    if (!body) return;
    for (const b of body.breakpoints || []) b.message = translate(b.message);
    if (m.command === 'dataBreakpointInfo' && body.dataId == null) body.description = translate(body.description);
    if (m.command === 'evaluate' && failed(body.presentationHint)) body.result = translate(body.result);
    // A value of the program's never matches: a string's is in quotes, the others are no sentences.
    for (const v of body.variables || []) v.value = translate(v.value);
  } else if (m.type === 'event' && body) {
    if (m.event === 'output' && ['console', 'important'].includes(body.category)) body.output = translate(body.output);
    else if (m.event === 'breakpoint' && body.breakpoint) body.breakpoint.message = translate(body.breakpoint.message);
    else if (m.event === 'stopped') {
      body.text = translate(body.text);
      body.description = translate(body.description);
    }
  }
}

/** Passenger over its stdin and stdout, as VS Code would run it, its messages translated on the way. */
class TranslatingAdapter {
  constructor(exe, args) {
    this.emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.emitter.event;
    this.process = cp.spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = Buffer.alloc(0);
    this.process.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.toString('ascii', 0, headerEnd))?.[1]);
        if (buffer.length < headerEnd + 4 + length) return;
        const message = JSON.parse(buffer.toString('utf8', headerEnd + 4, headerEnd + 4 + length));
        buffer = buffer.subarray(headerEnd + 4 + length);
        if (language() !== 'en') translateMessage(message);
        this.emitter.fire(message);
      }
    });
    this.process.on('error', (e) => this.emitter.fire({ type: 'event', event: 'output', body: { category: 'important', output: `${e.message}\n` } }));
    // An adapter that ends (or fails to start) ends the session, as VS Code ends it for an executable.
    this.process.on('close', () => this.emitter.fire({ type: 'event', event: 'terminated', body: {} }));
  }

  handleMessage(message) {
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    if (this.process.stdin.writable) this.process.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii'), json]));
  }

  dispose() {
    this.process.kill();
    this.emitter.dispose();
  }
}

module.exports = { TranslatingAdapter, translate };
