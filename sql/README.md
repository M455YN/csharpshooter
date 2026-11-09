# CSharpShooter SQL

T-SQL IntelliSense and syntax errors for VS Code and VSCodium, from Microsoft's
[SQL Tools Service](https://github.com/microsoft/sqltoolsservice) (MIT), the server behind vscode-mssql: an extension of
its own beside [CSharpShooter](../README.md), from the same repository, sharing its texts (`../l10n`).

## Build

```bash
npm ci                      # in the repository's root: the bundle takes vscode-languageclient from there
cd sql
npm run fetch-sqltools      # Microsoft's SQL Tools Service into sqltools/
npm run build-sqlcheck      # CSharpShooter.SqlCheck (sqlcheck/, the .NET 10 SDK) next to it
npm run package             # dist/extension.js (npm run bundle) and csharpshooter-sql-win32-x64-<version>.vsix
```

It is released from an `sql-v<version>` tag (`.github/workflows/sql-release.yml`), CSharpShooter from `v<version>`.
Its checks run in a real editor, with no SQL Server: `SUITE=sql/test/split-suite.js node test/runTest.js` from the root.

## Use

- **`.sql` files** in VS Code's own editor get the service's T-SQL IntelliSense (keywords, functions, snippets) and
  their syntax errors underlined and in Problems, with no connection to a server. The service starts on the installed
  .NET 10 once a `.sql` file is open; `csharpShooter.sqlToolsPath` points to another copy of it.
- **SQL in code**: `csharpShooter.sql.checkQuery(text)` gives a query's syntax errors (line, column, message) without
  showing it anywhere, at once: CSharpShooter.SqlCheck (`sqlcheck/`) calls the service's own parser (SqlParser, the
  service's options and positions) in a process of its own, where the service would wait 750 ms before each check. [C# Razor Tag Helper Support](https://github.com/M455YN/csharp-razor-taghelpers) uses it to
  underline the SQL of a Tag Helper's `select`, `insert`... in `.cshtml` and `.razor` files.

Running queries, connections and an object explorer are not part of it: a Tag Helper's query opens in SQL Server
Management Studio from C# Razor Tag Helper Support's *Open in SQL Server Management Studio*.
