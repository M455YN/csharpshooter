// Entity Framework Core migrations, as Passenger's Migrations (0.4.0's environments, #1839; 0.4.1's projects, #2011;
// 0.4.2's output folder, #2047) through the EF Core tools (dotnet ef): Add Migration..., Update Database..., Remove Last
// Migration, Generate SQL Script and the environment they run in, from a project's context menu in the Solution Explorer
// (Entity Framework Core) or the command palette. The project is one that declares a DbContext, the startup project the
// solution's (else that project), each context asked for where a project has more than one, and each context's
// migrations folder remembered. The commands run in a terminal task, so what the tools say is seen.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { t } = require('./l10n');
const { toolEnv } = require('./tool-env');
const { readSolution, terminalTask } = require('./solution');

const ENVIRONMENTS = ['Development', 'Staging', 'Production'];
/** A class deriving from a DbContext (DbContext, IdentityDbContext<...>, a context of the app's own named so). */
const CONTEXT = /\bclass\s+(\w+)\s*(?:<[^>{]*>)?\s*(?:\([^)]*\))?\s*:\s*(?:[\w.]+\.)?\w*DbContext\b/g;

/** The DbContext classes a project's own C# files declare (bin and obj left out). */
function contextsOf(projectFile) {
  const found = new Set();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 8 && !/^(bin|obj|node_modules|\..*)$/i.test(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (e.name.endsWith('.cs')) {
        let text;
        try {
          text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        } catch {
          continue;
        }
        if (!text.includes('DbContext')) continue;
        for (const m of text.matchAll(CONTEXT)) found.add(m[1]);
      }
    }
  };
  walk(path.dirname(projectFile), 0);
  return [...found].sort();
}

/** The lines `dotnet ef ... --json --prefix-output` writes as data, parsed. */
function efData(stdout) {
  const data = stdout.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice('data:'.length).trimStart()).join('\n');
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function registerMigrations(context, findSolution, startup) {
  const state = context.workspaceState;
  const environment = () => state.get('csharpShooter.ef.environment', 'Development');
  const env = () => ({ ASPNETCORE_ENVIRONMENT: environment(), DOTNET_ENVIRONMENT: environment() });

  /** The solution's projects that declare a DbContext, each with its contexts. */
  const contextProjects = async () => {
    const solution = await findSolution();
    if (!solution) return [];
    const walk = (node) => [...node.projects, ...node.folders.flatMap(walk)];
    return walk(readSolution(solution)).filter((f) => /\.csproj$/i.test(f) && fs.existsSync(f))
      .map((file) => ({ file, contexts: contextsOf(file) })).filter((p) => p.contexts.length);
  };

  /** The project, startup project and context a command runs on: the item's project (else one picked among those
   *  declaring a context), the solution's startup project (else that project), and its context (asked for if several). */
  const target = async (item, verb) => {
    let project = item?.file && /\.csproj$/i.test(item.file) ? { file: item.file, contexts: contextsOf(item.file) } : undefined;
    if (!project) {
      const all = await contextProjects();
      if (!all.length) return void vscode.window.showWarningMessage(t('No project of the solution declares a DbContext.'));
      project = all.length === 1 ? all[0] : (await vscode.window.showQuickPick(
        all.map((p) => ({ label: path.basename(p.file, '.csproj'), description: p.contexts.join(', '), p })), { placeHolder: t('Project with the DbContext ({0})', verb) }))?.p;
      if (!project) return undefined;
    }
    if (!project.contexts.length) return void vscode.window.showWarningMessage(t('{0} declares no DbContext.', path.basename(project.file, '.csproj')));
    const dbContext = project.contexts.length === 1 ? project.contexts[0]
      : await vscode.window.showQuickPick(project.contexts, { placeHolder: t('DbContext ({0})', verb) });
    if (!dbContext) return undefined;
    const startupProject = (await startup?.project?.()) || project.file;
    return { project: project.file, startupProject, dbContext };
  };

  const common = (to) => ['--project', to.project, '--startup-project', to.startupProject, '--context', to.dbContext];

  /** Whether the EF Core tools answer here (a global tool, or one the folder's tool manifest names); offers to install
   *  them where they do not. */
  const efReady = (cwd) => new Promise((resolve) => execFile('dotnet', ['ef', '--version'], { cwd, windowsHide: true, env: toolEnv(), timeout: 60000 }, (error) => resolve(!error)))
    .then(async (ok) => {
      if (ok) return true;
      const install = t('Install dotnet-ef');
      if (await vscode.window.showWarningMessage(t('The Entity Framework Core tools (dotnet ef) are not installed.'), install) === install) {
        await terminalTask(t('Install dotnet-ef'), ['tool', 'install', '--global', 'dotnet-ef'], cwd);
      }
      return false;
    });

  /** dotnet ef with the arguments in a terminal task, in the environment chosen; its exit code. */
  const run = async (name, args, to) => {
    const cwd = path.dirname(to.project);
    if (!(await efReady(cwd))) return undefined;
    return terminalTask(`${name} (${environment()})`, ['ef', ...args, ...common(to)], cwd, undefined, env());
  };

  /** The migrations of a context, as dotnet ef lists them without the database (oldest first): { id, name }. */
  const migrations = (to) => new Promise((resolve) => execFile('dotnet', ['ef', 'migrations', 'list', '--json', '--prefix-output', '--no-connect', ...common(to)],
    { cwd: path.dirname(to.project), windowsHide: true, env: toolEnv(env()), maxBuffer: 16 << 20, timeout: 600000 },
    (error, stdout) => resolve(error ? undefined : efData(stdout))));

  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('csharpShooter.ef.addMigration', async (item) => {
    const to = await target(item, t('Add Migration'));
    if (!to) return undefined;
    const name = await vscode.window.showInputBox({
      prompt: t('Migration name ({0})', to.dbContext),
      validateInput: (v) => (/^[A-Za-z_]\w*$/.test(v.trim()) ? undefined : t('A migration name is a C# identifier.')),
    });
    if (!name) return undefined;
    // Each context's folder, as Passenger keeps it (Migrations/Postgres, Migrations/SqlServer).
    const key = `csharpShooter.ef.output.${to.project.toLowerCase()}|${to.dbContext}`;
    const output = await vscode.window.showInputBox({ prompt: t('Output folder, relative to the project'), value: state.get(key, 'Migrations') });
    if (output === undefined) return undefined;
    await state.update(key, output.trim() || 'Migrations');
    return run(t('Add Migration'), ['migrations', 'add', name.trim(), '--output-dir', output.trim() || 'Migrations'], to);
  });

  register('csharpShooter.ef.updateDatabase', async (item) => {
    const to = await target(item, t('Update Database'));
    if (!to) return undefined;
    if (!(await efReady(path.dirname(to.project)))) return undefined;
    const list = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Reading the migrations of {0}...', to.dbContext) }, () => migrations(to));
    const latest = { label: t('Latest migration'), target: undefined };
    const items = [latest, ...[...(list || [])].reverse().map((m) => ({ label: m.name, description: m.id, target: m.id })), { label: '0', description: t('Before the first migration (every one undone)'), target: '0' }];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t('Update {0} to ({1})', to.dbContext, environment()) });
    if (!picked) return undefined;
    return run(t('Update Database'), ['database', 'update', ...(picked.target ? [picked.target] : [])], to);
  });

  register('csharpShooter.ef.removeMigration', async (item) => {
    const to = await target(item, t('Remove Last Migration'));
    if (!to) return undefined;
    const remove = t('Remove');
    if (await vscode.window.showWarningMessage(t("The last migration of {0} will be removed, and the model snapshot taken back. A migration already applied to the database is first undone there.", to.dbContext), { modal: true }, remove) !== remove) return undefined;
    return run(t('Remove Last Migration'), ['migrations', 'remove', '--force'], to);
  });

  register('csharpShooter.ef.script', async (item) => {
    const to = await target(item, t('Generate SQL Script'));
    if (!to) return undefined;
    // Idempotent where the provider can write one (SQLite cannot), else every migration from an empty database.
    const kind = await vscode.window.showQuickPick([
      { label: t('Idempotent'), description: t('runs on a database at any migration'), args: ['--idempotent'] },
      { label: t('From an empty database'), description: t('every migration, in order'), args: [] },
    ], { placeHolder: t('Generate SQL Script') });
    if (!kind) return undefined;
    const file = path.join(os.tmpdir(), `${to.dbContext}-${Date.now()}.sql`);
    const code = await run(t('Generate SQL Script'), ['migrations', 'script', ...kind.args, '--output', file], to);
    if (code === 0 && fs.existsSync(file)) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    return code;
  });

  register('csharpShooter.ef.environment', async (value) => {
    let chosen = typeof value === 'string' ? value : undefined;
    if (!chosen) {
      const other = t('Other...');
      const picked = await vscode.window.showQuickPick([...ENVIRONMENTS, other].map((label) => ({ label, description: label === environment() ? t('current') : '' })),
        { placeHolder: t('The environment migrations run in (ASPNETCORE_ENVIRONMENT, DOTNET_ENVIRONMENT)') });
      if (!picked) return undefined;
      chosen = picked.label === other ? (await vscode.window.showInputBox({ prompt: t('Environment name'), value: environment() }))?.trim() : picked.label;
    }
    if (!chosen) return undefined;
    await state.update('csharpShooter.ef.environment', chosen);
    return chosen;
  });

  return { contextsOf, contextProjects, environment };
}

module.exports = { registerMigrations, contextsOf, efData };
