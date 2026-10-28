# Third-party notices

CSharpShooter SQL bundles two programs it did not write. The MIT licence text they come under:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The SQL Tools Service (`sqltools/`)

Microsoft's [sqltoolsservice](https://github.com/microsoft/sqltoolsservice) release `Microsoft.SqlTools.ServiceLayer`
(win-x64, net10.0), under MIT, Copyright (c) Microsoft Corporation, with its own `sqltools/Notice.txt` for what it
carries (SqlClient, SMO and ScriptDom under MIT, DacFx under Microsoft's DacFx licence terms, which allow it to be
distributed with an application). `scripts/fetch-sqltools.js` leaves out its own copy of .NET, the migration tool and
the texts of languages other than English and Polish. The Connect dialog of `.sql` files (`sql-connect-dialog.js`) is laid out as SQL Server Management Studio 22's, with
its words for the same things (`Microsoft.SqlServer.ConnectionDlg.UI` and `SqlEditors` resources) in Polish and English;
no SSMS code or file ships with this extension, and SSMS's `RegSrvr17.xml` is only read where SSMS is installed.

## The Monaco editor (`media/monaco/`)

Microsoft's [monaco-editor](https://github.com/microsoft/monaco-editor) 0.55.1 from npm (its `min/vs`), under MIT,
Copyright (c) 2016 - present Microsoft Corporation, with its licence in `media/monaco/LICENSE` (copied by
`scripts/fetch-monaco.js`). The SQL editor page's layout follows [vsc-ms-sql-manager](https://github.com/jakubkozera/vsc-ms-sql-manager)
(MIT, Copyright (c) Jakub Kozera); none of its code is copied.

