# Third-party notices

CSharpShooter SQL bundles a program it did not write. The MIT licence text it comes under:

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
the texts of languages other than English and Polish.

## C# Razor Tag Helper Support (`razor/`)

`razor/tags.js` (its `folding.js` scanner), `razor/sql-query.js` and `razor/ssms.js` are copied from
[csharp-razor-taghelpers](https://github.com/M455YN/csharp-razor-taghelpers), MIT, Copyright (c) 2026 Mateusz Afelt,
the same author's.
