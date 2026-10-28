# CSharpShooter SQL

`.sql` files as in SQL Server Management Studio 22 and Visual Studio 2026, for VS Code and VSCodium: an extension of its
own beside [CSharpShooter](../README.md), from the same repository, sharing its texts (`../l10n`).

## Build

```bash
npm ci                      # in the repository's root: the bundle takes vscode-languageclient from there
cd sql
npm run fetch-sqltools      # Microsoft's SQL Tools Service into sqltools/
npm run fetch-monaco        # Monaco into media/monaco/
npm run package             # dist/extension.js (npm run bundle) and csharpshooter-sql-win32-x64-<version>.vsix
```

It is released from an `sql-v<version>` tag (`.github/workflows/sql-release.yml`), CSharpShooter from `v<version>`.
Its checks run in a real editor against a SQL Server: `SUITE=sql/test/sql-suite.js node test/runTest.js` from the root.

## Use

`.sql` files are query windows as in SQL Server Management Studio 22: T-SQL IntelliSense from the database the window
is connected to (its tables, columns, procedures, functions, after `dbo.` or an alias), syntax errors underlined, and
the connection in the status bar (*server (login) | database*), all from Microsoft's
[SQL Tools Service](https://github.com/microsoft/sqltoolsservice) (MIT), the server behind vscode-mssql, started on the
installed .NET 10 once a `.sql` file is open.

- A `.sql` file opens in the **Edytor SQL** page, as [vsc-ms-sql-manager](https://github.com/jakubkozera/vsc-ms-sql-manager)'s
  SQL editor has it (found with REA in its package: a custom editor for `*.sql` with Monaco, a toolbar with the
  connection and the database as drop-downs, `switchConnection`/`switchDatabase`/`executeQuery`/`cancelQuery`, and the
  results under the query in the same page): a toolbar (*▷ Wykonaj*, *■ Anuluj*, *✓ Analizuj*, the connection with
  *Zmień połączenie...* and *Rozłącz*, the database as a drop-down listing the server's databases, the query's state),
  the T-SQL in Monaco (shipped with the extension, not from a CDN), and *Wyniki*, *Komunikaty* and VS's status line
  under it, the split dragged. The file stays a text document the SQL Tools Service sees, so IntelliSense, hovers and
  underlined errors are the service's; `Ctrl+Shift+E`/`F5`, `Ctrl+F5`, `Alt+Break` and `Ctrl+S` work in it. *Otwórz
  za pomocą... > Edytor tekstu* (or `"workbench.editorAssociations": { "*.sql": "default" }`) gives VS Code's own
  editor with the toolbar row above line 1 and the bottom panel's results; *Nowe zapytanie* follows that choice.
- **Połącz** (the plug in the editor's title, or the status bar's *nie połączono*) opens SSMS 22's Connect dialog:
  - *Historia*: *Ulubione* (connections pinned with the star) and *Najnowsze połączenia*, SSMS's own recent
    connections, read from SSMS 21/22's `%APPDATA%\Microsoft\SQL Server Management Studio\RegSrvr17.xml` (the Registered
    Servers group `MruSqlConnectionsGroup`, where SSMS keeps its Connect dialog's history), with this extension's own
    before them; filtered as you type.
  - *Przeglądaj*: the solution's connection strings, the `ConnectionStrings` of each project's `appsettings*.json` and
    of its user secrets (the `UserSecretsId` of the `.csproj` next to it), and this machine's servers (its SQL Server
    instances and LocalDB's).
  - *Właściwości połączenia*: server name, Windows or SQL Server authentication, user name and password, *Zapamiętaj
    hasło*, database name (the server's databases are listed when the field is entered), *Szyfruj*, *Certyfikat serwera
    zaufania*, host name in certificate; *Parametry połączenia* shows the connection string they make, its password
    hidden, and takes one pasted in.

  Picking an entry fills the fields. A password SSMS remembered stays where it is: SSMS protects it with the user's
  Windows data protection (DPAPI, `RegisteredServer.ProtectData` in `Microsoft.SqlServer.Management.RegisteredServers`),
  and it is unprotected only when that entry connects, never shown in the page. SSMS's file is only read. A connection
  made here goes to the top of the history; its password is kept, in the editor's secret storage, only with *Zapamiętaj
  hasło*.
- A server whose certificate is not trusted is asked about, as SSMS asks, and connected to trusting it if wanted
  (remembered for that server).
- **Dostępne bazy danych** (the status bar, or the database icon) switches the window's database, with *Zmień
  połączenie...* and *Rozłącz* after the list.
- **Nowe zapytanie** opens a query window; a window that opens connects to the workspace's last connection by itself.
- **Wykonaj** (`Ctrl+Shift+E` as in Visual Studio, `F5` as in SSMS, or the play button in the editor's title) runs the
  selection, or the whole window, on its connection; a window not connected yet asks for a connection first.
  *Anuluj wykonywanie zapytania* is `Alt+Break`. The results come in the bottom panel's **Wyniki zapytania**, as SSMS
  shows them under the query: *Wyniki*, a grid per result set (NULL marked, a cell copied with `Ctrl+C`, up to 2000
  rows of a set), *Komunikaty* (PRINT, rows affected, errors; an error's line opens in the query) and the status line
  (*Zapytanie zostało wykonane pomyślnie.*, server, login, database, time, rows).
- The query window has Visual Studio 2026's SQL editor toolbar in the editor's title (its commands, found with REA in
  `Microsoft.VisualStudio.Data.Tools.SqlEditor.dll`: `SqlEditorExecuteQueryCommand`, `CancelQuery`, `ParseQuery`,
  `Connect`, `Disconnect`, `ChangeConnection`, `SqlDatabaseList`): *Wykonaj*, *Anuluj wykonywanie zapytania* while one
  runs, *Analizuj* (`Ctrl+F5`, the window checked under `SET PARSEONLY` as SSMS sends it), *Połącz* or *Rozłącz* and
  *Zmień połączenie...*. The same toolbar is a row above the first line, inside the editor: *Wykonaj* (or *Anuluj*),
  *Analizuj*, the connection (*Zmień połączenie...* on a click) and the database as VS's drop-down (a click lists the
  server's databases, the current one marked), a little larger than VS Code's code lenses (`[sql]`
  `editor.codeLensFontSize` 14, which a user's own setting overrides). The status bar is VS's query status (`QEStatusBarManager`): the state
  on the left (*Otwarto nowe połączenie*, *Trwa wykonywanie zapytania...*, *Zapytanie zostało wykonane pomyślnie.*),
  then server (version, e.g. `16.0 RTM`), login (SPID), database (a click lists the databases), the last query's time
  and rows.
- **Eksplorator obiektów SQL Server**, its own icon in the activity bar after the Solution Explorer's, as Visual Studio 2026's SQL Server Object Explorer
  (SSDT): a *SQL Server* node with the servers connected to through the dialog (or added with *Dodaj SQL Server...*),
  each with the tree SSMS's Object Explorer shows, from the SQL Tools Service (*Bazy danych*, *Systemowe bazy danych*,
  *Tabele*, *Widoki*, *Możliwość programowania*, *Zabezpieczenia*, a table's *Kolumny*, *Klucze*, *Indeksy*...). A
  server, database or object has *Nowe zapytanie* (a query window connected to its database), a table or view *Wybierz
  pierwszych 1000 wierszy* (SSMS's query, run), and *Odśwież*; a server *Rozłącz* and *Usuń*. A folder the service
  can filter (*Tabele*, *Widoki*, *Procedury składowane*...) has SSMS's *Ustawienia filtru...* (also the funnel on
  hover): the server and database, a row per property (*Nazwa*, *Schemat*, *Właściciel*, *Data utworzenia*...) with
  its operator (*Zawiera*, *Równa się*, *Między*...) and value, its description below, *Wyczyść filtr*, *OK*, *Anuluj*;
  the folder then reads *Tabele (przefiltrowane)*, and *Usuń filtr* takes it off.

SSMS's words for all this (its `ConnectionDlg` and `SqlEditors` resources) are taken in Polish and English.

Not like SSMS: execution plans, results to text or file, Edit Top 200 Rows, Script As, the table designer and the
other designers and wizards; Microsoft Entra ID authentication; the dialog's network and Azure browsing, its
custom name and color, and favorites shared with SSMS (pins are this extension's own).

