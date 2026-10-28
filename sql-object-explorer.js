// SQL Server Object Explorer as in Visual Studio 2026 (SSDT's tool window), in the side bar under the Solution Explorer:
// a "SQL Server" node with the servers added (Add SQL Server opens SSMS's Connect dialog), each server's tree as SQL
// Server Management Studio shows it (Databases, System Databases, Tables, Views, Programmability, Security, a table's
// Columns, Keys, Indexes...), from the SQL Tools Service's object explorer, whose labels come in the UI's language. A
// database's or an object's New Query opens a query window connected to its database; a table's or a view's Select Top
// 1000 Rows writes SSMS's query and runs it.
const vscode = require('vscode');
const { table } = require('./l10n');
const { showFilterDialog } = require('./sql-filter-dialog');

const T = table({
  root: 'SQL Server',
  notConnected: 'not connected',
  noPassword: 'The password of {0} is not remembered: connect to it again.',
  failed: 'Cannot connect to {0}: {1}',
  filtered: '{0} (filtered)',
});

// codicons for the explorer's node types
const ICONS = {
  Server: 'server', Database: 'database', Folder: 'folder', Table: 'table', View: 'eye', Column: 'symbol-field',
  Key: 'key', Index: 'list-tree', Constraint: 'lock', Trigger: 'zap', StoredProcedure: 'symbol-method',
  TableValuedFunction: 'symbol-function', ScalarValuedFunction: 'symbol-function', AggregateFunction: 'symbol-function',
  User: 'person', Role: 'organization', Schema: 'symbol-namespace', Synonym: 'symbol-reference', UserDefinedDataType: 'symbol-class',
  Statistic: 'graph', Login: 'person', StoredProcedureParameter: 'symbol-parameter', TableValuedFunctionParameter: 'symbol-parameter',
};

/** sql: the SQL module's { start, request, on, servers, connectionString(server), addServer(), forget(server),
 *  newQuery(connectionString, text, run) }. */
function registerSqlObjectExplorer(context, sql) {
  const changed = new vscode.EventEmitter();
  const sessions = new Map(); // server key -> { id, rootPath, label } | Promise of it
  const expansions = new Map(); // `${session}|${path}` -> resolve of objectexplorer/expandCompleted
  const created = new Map(); // session id -> resolve of objectexplorer/sessioncreated
  const root = { kind: 'root' };
  const filters = new Map(); // `${server key}|${node path}` -> the folder's filters, as SSMS's Filter Settings set them
  const filterKey = (node) => `${node.server.key}|${node.info.nodePath}`;

  const early = new Map(); // session id -> its objectexplorer/sessioncreated, come before createsession's reply
  sql.on('objectexplorer/sessioncreated', (p) => (created.has(p.sessionId) ? created.get(p.sessionId)(p) : early.set(p.sessionId, p)));
  sql.on('objectexplorer/expandCompleted', (p) => expansions.get(`${p.sessionId}|${p.nodePath}`)?.(p));

  async function session(server) {
    if (sessions.has(server.key)) return sessions.get(server.key);
    const pending = (async () => {
      const connectionString = await sql.connectionString(server);
      if (!connectionString) throw new Error(T.noPassword(server.fields.server));
      await sql.start();
      const reply = await sql.request('objectexplorer/createsession', { options: { connectionString } });
      const result = early.get(reply.sessionId) || (await new Promise((r) => created.set(reply.sessionId, r)));
      created.delete(reply.sessionId);
      early.delete(reply.sessionId);
      if (!result.success) throw new Error(result.errorMessage);
      return { id: result.sessionId, rootPath: result.rootNode.nodePath, label: result.rootNode.label };
    })();
    sessions.set(server.key, pending);
    try {
      const s = await pending;
      sessions.set(server.key, s);
      changed.fire(undefined);
      return s;
    } catch (e) {
      sessions.delete(server.key);
      throw e;
    }
  }

  // A folder's filters go with its expand; the service keeps the children it expanded, so a changed filter refreshes.
  async function expand(server, nodePath, refresh, nodeFilters) {
    const s = await session(server);
    const done = new Promise((r) => expansions.set(`${s.id}|${nodePath}`, r));
    await sql.request(refresh ? 'objectexplorer/refresh' : 'objectexplorer/expand', { sessionId: s.id, nodePath, filters: nodeFilters?.length ? nodeFilters : undefined });
    const result = await done;
    expansions.delete(`${s.id}|${nodePath}`);
    if (result.errorMessage) throw new Error(result.errorMessage);
    return result.nodes || [];
  }

  async function close(server) {
    const s = sessions.get(server.key);
    sessions.delete(server.key);
    if (s && !(s instanceof Promise)) await sql.request('objectexplorer/closesession', { sessionId: s.id }).catch(() => {});
  }

  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem(node) {
      if (node.kind === 'root') {
        const item = new vscode.TreeItem(T.root, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('server-environment');
        item.contextValue = 'sqlRoot';
        return item;
      }
      if (node.kind === 'server') {
        const s = sessions.get(node.server.key);
        const connected = s && !(s instanceof Promise);
        // VS's "(localdb)\MSSQLLocalDB (SQL Server 16.0.1000 - KDR\user)"; STS's root label is "server (SQL Server x)".
        const label = connected ? s.label.replace(/\)$/, ` - ${node.server.user})`) : node.server.fields.server;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `server:${node.server.key}`;
        item.description = connected ? undefined : T.notConnected;
        item.iconPath = new vscode.ThemeIcon(connected ? 'server' : 'debug-disconnect');
        item.contextValue = connected ? 'sqlServer connected' : 'sqlServer';
        item.tooltip = `${node.server.fields.server}\n${node.server.user}${node.server.fields.database ? `\n${node.server.fields.database}` : ''}`;
        return item;
      }
      const info = node.info;
      const filtered = filters.get(filterKey(node))?.length;
      const item = new vscode.TreeItem(filtered ? T.filtered(info.label) : info.label, info.isLeaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${node.server.key}|${info.nodePath}`;
      item.iconPath = new vscode.ThemeIcon(filtered ? 'filter' : ICONS[info.nodeType] || (info.isLeaf ? 'symbol-misc' : 'folder'));
      item.contextValue = `sqlNode ${info.nodeType}${info.filterableProperties?.length ? ' filterable' : ''}${filtered ? ' filtered' : ''}`;
      item.tooltip = info.errorMessage || info.label;
      return item;
    },
    async getChildren(node) {
      if (!node) return [root];
      if (node.kind === 'root') return sql.servers().map((server) => ({ kind: 'server', server }));
      try {
        const nodePath = node.kind === 'server' ? (await session(node.server)).rootPath : node.info.nodePath;
        const refresh = node.refresh;
        node.refresh = false;
        const nodeFilters = node.kind === 'node' ? filters.get(filterKey(node)) : undefined;
        return (await expand(node.server, nodePath, refresh, nodeFilters)).map((info) => ({ kind: 'node', server: node.server, info, parent: node }));
      } catch (e) {
        vscode.window.showErrorMessage(T.failed(node.server.fields.server, e.message));
        return [];
      }
    },
    getParent: (node) => (node.kind === 'root' ? undefined : node.kind === 'server' ? root : node.parent),
  };
  const view = vscode.window.createTreeView('csharpShooter.sqlObjectExplorer', { treeDataProvider: provider, showCollapseAll: true });

  /** The database a node is in (its own name for a database). */
  function databaseOf(node) {
    for (let n = node; n && n.kind === 'node'; n = n.parent) if (n.info.nodeType === 'Database') return n.info.metadata?.name || n.info.label.replace(/ \(.*\)$/, '');
    return undefined;
  }

  async function connectionStringFor(node) {
    const connectionString = await sql.connectionString(node.server);
    const database = databaseOf(node);
    return database ? sql.withDatabase(connectionString, database) : connectionString;
  }

  const bracket = (name) => `[${name.replace(/]/g, ']]')}]`;

  /** SSMS's Select Top 1000 Rows: the table's columns by name, from its Columns folder. */
  async function selectTop(node) {
    const { schema, name } = node.info.metadata || {};
    const children = await expand(node.server, node.info.nodePath);
    const columnsFolder = children.find((c) => /\/Columns$/i.test(c.nodePath)) || children[0];
    const columns = columnsFolder ? (await expand(node.server, columnsFolder.nodePath)).map((c) => c.metadata?.name || c.label.replace(/ \(.*\)$/, '')) : [];
    const list = columns.length ? columns.map(bracket).join('\n      ,') : '*';
    const text = `SELECT TOP (1000) ${list}\n  FROM ${bracket(databaseOf(node))}.${bracket(schema || 'dbo')}.${bracket(name || node.info.label)}\n`;
    return sql.newQuery(await connectionStringFor(node), text, true);
  }

  /** SSMS's Filter Settings for a folder: the folder is expanded again with them, and says "(filtered)". */
  async function filter(node, given) {
    const chosen = given ?? (await showFilterDialog({ server: node.server.fields.server, database: databaseOf(node),
      properties: node.info.filterableProperties, filters: filters.get(filterKey(node)) }));
    if (chosen === undefined) return undefined;
    if (chosen.length) filters.set(filterKey(node), chosen);
    else filters.delete(filterKey(node));
    node.refresh = true;
    changed.fire(node);
    await view.reveal(node, { expand: true }).then(undefined, () => {});
    return chosen;
  }

  context.subscriptions.push(view, changed,
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.filter', (node) => filter(node)),
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.clearFilter', (node) => filter(node, [])),
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.addServer', async () => {
      if (await sql.addServer()) changed.fire(undefined);
    }),
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.refresh', (node) => {
      if (!node || node.kind === 'root') return changed.fire(undefined);
      node.refresh = node.kind === 'node';
      changed.fire(node);
    }),
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.newQuery', async (node) => sql.newQuery(await connectionStringFor(node), '', false)),
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.selectTop', selectTop),
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.disconnect', async (node) => {
      await close(node.server);
      changed.fire(undefined);
    }),
    vscode.commands.registerCommand('csharpShooter.sqlExplorer.remove', async (node) => {
      await close(node.server);
      await sql.forget(node.server);
      changed.fire(undefined);
    }),
  );
  // For the tests.
  return { provider, view, refresh: () => changed.fire(undefined), selectTop, databaseOf, filter, filterDialog: () => showFilterDialog.last };
}

module.exports = { registerSqlObjectExplorer };
