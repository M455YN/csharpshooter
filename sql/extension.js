// CSharpShooter SQL: .sql files as in SSMS 22 and Visual Studio 2026 (sql.js), an extension of its own beside
// CSharpShooter, so the C# one carries neither SQL Tools Service nor Monaco. Its texts are CSharpShooter's (../l10n).
const { registerSql } = require('./sql');

function activate(context) {
  return { sql: registerSql(context), extensionPath: context.extensionPath };
}

function deactivate() {}

module.exports = { activate, deactivate };
