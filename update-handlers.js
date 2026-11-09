// CSharpShooter's end of its hook in a program debugged with Hot Reload (update-handlers/, Passenger's UpdateHandlerHook at
// 9954e4b, MIT): a loopback socket of the launch's own the hook connects to as the program starts, told after each update
// the debugger applied, so the program's MetadataUpdateHandlers run as the runtime's own Hot Reload agent runs them (every
// ClearCache, then every UpdateApplication) and a Blazor component renders the edit at once. Never waited on for long: the
// program may be paused, the hook's thread with it, and runs the handlers as it goes on.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const SOCKET = 'CSHARPSHOOTER_UPDATE_HANDLERS';
const HOOKS = 'DOTNET_STARTUP_HOOKS';
const hookPath = (extensionPath) => path.join(extensionPath, 'update-handlers', 'out', 'CSharpShooter.UpdateHandlers.dll');

/** The hook for a program about to start: { hook, env } with the variables that load it over env; undefined on a .NET
 *  older than the hook's (8) or with the hook not built. */
async function prepareUpdateHandlers(extensionPath, props, env) {
  const major = Number(/^v?(\d+)/.exec(props?.TargetFrameworkVersion || '')?.[1]);
  const dll = hookPath(extensionPath);
  if ((major && major < 8) || !fs.existsSync(dll)) return undefined;
  const hook = new UpdateHandlerHook();
  const port = await hook.listening;
  const others = env[HOOKS] ?? process.env[HOOKS];
  return { hook, env: { ...env, [SOCKET]: `${port} ${hook.key}`, [HOOKS]: others ? `${dll}${path.delimiter}${others}` : dll } };
}

class UpdateHandlerHook {
  constructor() {
    this.key = crypto.randomBytes(24).toString('hex');
    this.says = () => {};
    this.waiting = [];
    this.server = net.createServer((socket) => this.accept(socket));
    this.listening = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  /** The hook's one connection, once it says the key it was given; nothing else may connect after it. */
  accept(socket) {
    let buffer = '';
    let proven = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.waiting.splice(0).forEach((w) => w.resolve(undefined));
      }
    });
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > 1 << 20) return socket.destroy();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        if (!proven) {
          if (line !== this.key || this.socket) return socket.destroy();
          proven = true;
          this.socket = socket;
          this.server.close();
        } else if (line.startsWith('failed ')) {
          const failure = line.slice('failed '.length);
          this.waiting[0]?.failures.push(failure);
          this.says(failure);
        } else if (line === 'done') {
          const done = this.waiting.shift();
          done?.resolve(done.failures);
        }
      }
    });
  }

  /** Whether the hook connected: the program started with it and runs its handlers when told. */
  get connected() {
    return !!this.socket;
  }

  /** Tells the hook the debugger applied an update; resolves to the handlers' failures once they ran, or undefined when the
   *  hook is not connected or did not answer within `wait` ms (a paused program runs them as it goes on). */
  updated(wait = 2000) {
    if (!this.socket) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const entry = { failures: [], resolve };
      this.waiting.push(entry);
      setTimeout(() => resolve(undefined), wait).unref?.();
      this.socket.write('updated\n');
    });
  }

  dispose() {
    this.server.close();
    this.socket?.destroy();
    this.waiting.splice(0).forEach((w) => w.resolve(undefined));
  }
}

module.exports = { prepareUpdateHandlers, hookPath };
