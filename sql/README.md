# CSharpShooter SQL

CSharpShooter's SQL add-on for VS Code and VSCodium: T-SQL IntelliSense and syntax errors from Microsoft's
[SQL Tools Service](https://github.com/microsoft/sqltoolsservice) (MIT), the server behind vscode-mssql, and the SQL of
Razor Tag Helpers opened in SQL Server Management Studio and checked as you type. It needs
[CSharpShooter](../README.md) (`extensionDependencies`), comes from the same repository and shares its texts (`../l10n`).

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
- **SQL in Razor pages**: the attributes of `csharpShooter.sql.razorAttributes` (`select`, `insert`, `update`,
  `delete`, `move`, `lookup-sql`, `sql` on any tag) hold SQL, often a C# verbatim string (`select=@(@"...")`).
  - *Otwórz select w SQL Server Management Studio* above each opens it in the newest SSMS installed, runnable: the C#
    string's `""` made `"`, and a `declare` for each variable the app passes in (`@UserEmployeeId`, `@$DateFrom`, a
    table for one read `from`), under a line naming the Tag Helper and attribute. SSMS connects with the server,
    database and login of a connection string of the nearest `appsettings*.json` above the page (asked when several;
    the password is never passed). `csharpShooter.sql.razorCodeLens` turns it off.
  - Its syntax errors are underlined where they are in the page and listed in Problems, as you type.
    `csharpShooter.sql.razorDiagnostics` turns it off.
  - With [C# Razor Tag Helper Support](https://github.com/M455YN/csharp-razor-taghelpers) installed, that extension
    does both (by its `sqlHighlighting.rules`) and this one steps aside, so a page never gets them twice.
- **SQL in code**: `csharpShooter.sql.checkQuery(text)` gives a query's syntax errors (line, column, message) without
  showing it anywhere, at once: CSharpShooter.SqlCheck (`sqlcheck/`) calls the service's own parser (SqlParser, the
  service's options and positions) in a process of its own, where the service would wait 750 ms before each check.
  A mistyped clause word on a later line of a statement (`wherse ...` then `ordser by ...`) is found too, where the
  parser, and SSMS with it, stops at the first.

Running queries, connections and an object explorer are not part of it: a query runs in SQL Server Management Studio.
