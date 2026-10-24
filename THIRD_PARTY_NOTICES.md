# Third-party notices

CSharpShooter bundles two programs it did not write.

## The .NET debugger (`debugger/`)

The debug adapter of [Passenger](https://github.com/Zaneris/passenger) 0.2.0, ported to .NET 10 by
`debugger-port/net10.patch` (its `0.2.0` branch at commit `b4a6eb1`). Its licence and the notices for what it carries in turn are copied beside it by
`scripts/build-debugger.ps1` (`debugger/LICENSE.Passenger.txt`, `debugger/THIRD_PARTY_NOTICES.Passenger.md`).

```
MIT License

Copyright (c) 2026 Ted L

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

## The C# language server (`server/`)

Microsoft's `roslyn-language-server` package from nuget.org, under MIT, with its own `server/ThirdPartyNotices.rtf`
(copied by `scripts/fetch-server.js`). It carries two assemblies that are not open source,
`Microsoft.VisualStudio.Telemetry` and `Microsoft.VisualStudio.Utilities.Internal`, under Microsoft's Visual Studio
licence terms; Razor's support loads them, and the server runs with `--telemetryLevel off`.
