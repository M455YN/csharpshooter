# Changelog

All notable changes to **CSharpShooter SQL** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `csharpShooter.sql.checkQuery` gives the syntax errors of SQL in code (line, column, message), with no connection and without showing it, in a few milliseconds: CSharpShooter.SqlCheck (`sqlcheck/`, built by `npm run build-sqlcheck`) calls the SQL Tools Service's own parser with its options, in a process of its own, where the service waits 750 ms before each check and lets a newer one cancel it. Where the parser stops after a statement's first error (as SSMS 22 does), a mistyped clause word starting a later line (`wherse …` then `ordser by …`) is found too, by parsing again with the erring line blanked; nothing else that parse says is taken, so it adds no error of its own. C# Razor Tag Helper Support underlines a Tag Helper's SQL with it.

### Changed

- CSharpShooter SQL is the SQL Tools Service alone: `.sql` files open in VS Code's own editor with T-SQL IntelliSense and their syntax errors underlined, with no connection to a server.

### Removed

- The SQL editor page (Monaco), connections and SSMS's Connect dialog, *Wykonaj*/*Anuluj*/*Analizuj* and the *Wyniki zapytania* panel, the toolbar row and query status bar, and the *Eksplorator obiektów SQL Server*. A Tag Helper's query runs in SQL Server Management Studio, from C# Razor Tag Helper Support's *Open in SQL Server Management Studio*.

## [0.1.0] - 2026-10-28

### Added

- `.sql` files are query windows as in SQL Server Management Studio 22: T-SQL IntelliSense from the connected database (tables, columns, procedures, functions, after `dbo.` or an alias), syntax errors underlined, and the window's connection in the status bar (server, login, database), from Microsoft's SQL Tools Service (MIT), fetched into `sqltools/` by `npm run fetch-sqltools` and run on the installed .NET 10. *Połącz* opens SSMS 22's Connect dialog: its History with SSMS's own recent connections (read from `RegSrvr17.xml`, their remembered passwords unprotected with the user's DPAPI only when they connect) and pinned favorites, Browse with the solution's connection strings (`appsettings*.json` and the projects' user secrets) and this machine's servers, the Connection Properties (Windows or SQL Server authentication, Remember Password, the server's databases, Encrypt, Trust Server Certificate, host name in certificate) and the Connection String; *Dostępne bazy danych* switches the database; *Nowe zapytanie* opens a window that connects to the last connection by itself. Its words are SSMS's own, in Polish and English.
- *Wykonaj* (`Ctrl+Shift+E` as in Visual Studio, `F5` as in SSMS) runs a `.sql` window's selection or all of it; its results come in the bottom panel's *Wyniki zapytania* as SSMS shows them: *Wyniki* (a grid per result set), *Komunikaty* (an error's line opens in the query) and the status line.
- *Eksplorator obiektów SQL Server*, its own icon in the activity bar, as Visual Studio 2026's SQL Server Object Explorer: the servers connected to, each with SSMS's Object Explorer tree from the SQL Tools Service, *Nowe zapytanie* on a server, database or object, and *Wybierz pierwszych 1000 wierszy* on a table or view.
- A `.sql` window has Visual Studio 2026's SQL editor toolbar (Execute, Cancel Executing Query, Parse with `Ctrl+F5`, Connect, Disconnect, Change Connection), also as a row above the first line with the database as VS's drop-down, and its query status bar (state, server (version), login (SPID), database, time, rows).
- The SQL Server Object Explorer's folders have SSMS's *Ustawienia filtru...* (name, schema, owner, create date... with SSMS's operators) and *Usuń filtr*; a filtered folder reads *(przefiltrowane)*.
- `.sql` files open in the *Edytor SQL* page, as vsc-ms-sql-manager's SQL editor: a toolbar with Execute, Cancel, Parse, the connection and the database as drop-downs, the T-SQL in Monaco (`npm run fetch-monaco`, shipped in `media/monaco`) with the SQL Tools Service's IntelliSense, and the results under it in the same page. *Reopen With > Text Editor* keeps VS Code's own editor.
- The SQL editor page's completion gives the items matching the word typed, a database's tables, views and functions before its keywords (a large database's list was cut before its tables), and says *Przygotowywanie funkcji IntelliSense...* while the service loads the database's names.
