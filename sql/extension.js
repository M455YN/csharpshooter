// CSharpShooter SQL: T-SQL IntelliSense and syntax errors from SQL Tools Service (sql.js), an extension of its own beside
// CSharpShooter, so the C# one does not carry the service. Its texts are CSharpShooter's (../l10n).
const { registerSql } = require('./sql');

function activate(context) {
  return { sql: registerSql(context), extensionPath: context.extensionPath };
}

function deactivate() {}

module.exports = { activate, deactivate };
