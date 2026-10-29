// Hot Reload under the debugger (F5), as Passenger does it: Roslyn's own Edit and Continue service, in the C# server through
// roslyn-extension/ (Passenger's handlers), compares the solution as the editors have it with what was built and emits
// the deltas; the debugger (Passenger's) applies them with its applyChanges, the program paused or running. On each save
// of a .cs, .razor or .cshtml file while a session with hotReload runs.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { t } = require('./l10n');

const TYPE = 'csharpshooter';
const CODE = /\.(cs|razor|cshtml)$/i;
const HANDLER = (name) => `Passenger.Roslyn.Extension.${name}HotReload`;

/** server: () => the started LanguageClient, or undefined. Returns what the tests read: the sessions and the last outcome. */
function registerHotReload(context, server) {
  const diagnostics = vscode.languages.createDiagnosticCollection('Hot Reload');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const sessions = new Map(); // debug session id → its Hot Reload
  const api = { sessions, last: undefined, applied: new vscode.EventEmitter() };

  const ask = async (name, message) => {
    const client = server();
    if (!client) throw new Error(t('the C# language server has not started'));
    const answer = await client.sendRequest('workspace/_vs_dispatchExtensionMessage', { messageName: HANDLER(name), message: JSON.stringify(message) });
    if (answer?.extensionException) throw new Error(answer.extensionException.message || answer.extensionException.Message || JSON.stringify(answer.extensionException));
    if (!answer?.response) throw new Error(t('the C# language server gave no answer'));
    return JSON.parse(answer.response);
  };
  const tell = (name, session) => ask(name, { session }).then((done) => done.problem && console.warn(`Hot Reload ${name}: ${done.problem}`), () => {});

  const say = (text, error) => {
    status.text = `${error ? '$(error)' : '$(flame)'} ${text}`;
    status.show();
    clearTimeout(status.hide_);
    status.hide_ = setTimeout(() => status.hide(), 8000);
  };

  const problemsShown = (problems) => {
    diagnostics.clear();
    const byFile = new Map();
    for (const p of problems.filter((p) => p.path)) {
      const d = new vscode.Diagnostic(new vscode.Range(p.startLine, p.startColumn, p.endLine, p.endColumn), p.message,
        p.error ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.code = p.id;
      d.source = 'Hot Reload';
      byFile.set(p.path, [...(byFile.get(p.path) || []), d]);
    }
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
  };

  async function apply(hr) {
    const debug = hr.debug;
    if (hr.stopped) return { result: 'failed', said: hr.stopped };
    hr.starting ||= start(hr);
    if ((await hr.starting) !== undefined) {
      // The server may have been loading at the first edit: started again, the originals given again.
      hr.given.clear();
      hr.starting = start(hr);
      const why = await hr.starting;
      if (why !== undefined) return { result: 'failed', said: why };
    }
    const state = await debug.customRequest('hotReloadState', { hold: !hr.paused });
    try {
      if (!state.capabilities) return { result: 'failed', said: state.capabilitiesUnknown || t("The program's runtime did not say which edits it can take") };
      // The runtime takes explicit interface implementations (a Razor view's async ExecuteAsync state machine) since .NET 7
      // but does not say so; dotnet watch adds it as well. GenericUpdateMethod marks a .NET 8 or later runtime.
      const capabilities = state.capabilities.includes('GenericUpdateMethod') ? [...new Set([...state.capabilities, 'AddExplicitInterfaceImplementation'])] : state.capabilities;
      const emitted = await ask('Emit', {
        session: hr.id, paused: hr.paused, held: !!state.held, capabilities,
        modules: state.modules.filter((m) => m.editable).map((m) => m.mvid),
        activeStatements: state.activeStatements || [],
        locked: state.modules.filter((m) => !m.editable).map((m) => ({ module: m.mvid, why: m.whyNot || t('{0} cannot be edited', m.name) })),
        originals: ungiven(hr),
      });
      if (emitted.problem) return { result: 'failed', said: t('Hot Reload failed: {0}', emitted.problem) };
      const errors = emitted.problems.filter((p) => p.error);
      const named = errors.slice(0, 2).map((p) => `${p.message} (${p.path ? `${path.basename(p.path)}:${p.startLine + 1}` : p.project || ''})`).join('; ');
      if (emitted.status === 'none') return { result: 'none', said: t('No managed code changes to apply.'), problems: emitted.problems };
      if (emitted.status === 'blocked') {
        const compiles = !errors.some((p) => !p.restartRequired);
        return compiles ? { result: 'restart', said: t('Restart is needed to apply the changes: {0}', named), problems: emitted.problems }
          : { result: 'errors', said: t('Unable to apply changes due to compilation errors: {0}', named), problems: emitted.problems };
      }
      let applied;
      try {
        applied = await debug.customRequest('applyChanges', { updates: emitted.updates });
      } catch (e) {
        await tell('Discard', hr.id);
        return { result: 'failed', said: t('The debugger could not apply the changes: {0}', e.message), problems: emitted.problems };
      }
      const refused = applied.modules.find((m) => !m.applied);
      if (refused) {
        await tell('Discard', hr.id);
        // The program may hold part of the update: Hot Reload stops for the session.
        hr.stopped = refused.message || t('The runtime refused the update to {0}: restart to apply changes', refused.name);
        return { result: 'failed', said: hr.stopped, problems: emitted.problems };
      }
      await tell('Commit', hr.id);
      // A view's C# is generated, in no file of its own: the files saved name what was applied.
      const files = [...new Set([...emitted.changedDocuments, ...hr.saved])];
      hr.saved.clear();
      return { result: 'applied', said: t('Changes applied: {0}', files.map((f) => path.basename(f)).join(', ')), problems: emitted.problems, files };
    } finally {
      if (state.held) await Promise.resolve(debug.customRequest('hotReloadRelease')).catch(() => {});
    }
  }

  /** Roslyn's session, at the session's first edit: undefined once started, else why not. */
  async function start(hr) {
    try {
      const started = await ask('Start', { capabilities: [], originals: ungiven(hr) });
      if (started.problem) return started.problem;
      hr.id = started.session;
      if (hr.ended) tell('End', hr.id);
      return undefined;
    } catch (e) {
      return t('Hot Reload could not start: {0}', e.message);
    }
  }

  const ungiven = (hr) => {
    const out = [...hr.originals].filter(([p]) => !hr.given.has(p)).map(([file, text]) => ({ path: file, text }));
    out.forEach((o) => hr.given.add(o.path));
    return out;
  };

  const live = () => [...sessions.values()].filter((hr) => !hr.ended);
  const queue = (hr) => {
    clearTimeout(hr.timer);
    hr.timer = setTimeout(() => {
      hr.running = (hr.running || Promise.resolve()).then(async () => {
        const outcome = await apply(hr).catch((e) => ({ result: 'failed', said: t('Hot Reload failed: {0}', e.message) }));
        api.last = outcome;
        problemsShown(outcome.problems || []);
        say(outcome.said, outcome.result !== 'applied' && outcome.result !== 'none');
        if (outcome.result === 'restart' || (outcome.result === 'failed' && hr.stopped)) {
          const restart = t('Restart');
          vscode.window.showWarningMessage(outcome.said, restart).then((c) => c === restart && vscode.commands.executeCommand('csharpShooter.restart'));
        } else if (outcome.result === 'errors' || outcome.result === 'failed') {
          vscode.window.showWarningMessage(outcome.said);
        }
        api.applied.fire(outcome);
      });
    }, 300);
  };

  context.subscriptions.push(diagnostics, status, api.applied,
    vscode.debug.onDidStartDebugSession((s) => {
      if (s.type === TYPE && s.configuration.hotReload) {
        sessions.set(s.id, { debug: s, originals: new Map(), given: new Set(), saved: new Set(), paused: false });
      }
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      const hr = sessions.get(s.id);
      if (!hr) return;
      sessions.delete(s.id);
      hr.ended = true;
      clearTimeout(hr.timer);
      if (hr.id !== undefined) tell('End', hr.id);
      if (!sessions.size) diagnostics.clear();
    }),
    vscode.debug.registerDebugAdapterTrackerFactory(TYPE, {
      createDebugAdapterTracker: (s) => ({
        onDidSendMessage: (m) => {
          const hr = sessions.get(s.id);
          if (hr && m.type === 'event' && (m.event === 'stopped' || m.event === 'continued')) hr.paused = m.event === 'stopped';
        },
      }),
    }),
    // Each file's text before its first edit in the session: the build's, unless saved since, which Roslyn checks by the PDB.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || !CODE.test(e.document.fileName) || !e.contentChanges.length) return;
      for (const hr of live()) {
        if (hr.originals.has(e.document.fileName)) continue;
        try {
          hr.originals.set(e.document.fileName, fs.readFileSync(e.document.fileName, 'utf8').replace(/^﻿/, ''));
        } catch {
          continue;
        }
        hr.starting ||= start(hr);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.scheme !== 'file' || !CODE.test(d.fileName)) return;
      for (const hr of live()) {
        hr.saved.add(d.fileName);
        queue(hr);
      }
    }));
  return api;
}

module.exports = { registerHotReload };
