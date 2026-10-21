# CSharpShooter for VSCodium

A prototype extension: C# and Razor (`.cs`, `.cshtml`, `.razor`) from Microsoft's
[`roslyn-language-server`](https://www.nuget.org/packages?q=roslyn-language-server) (MIT), debugging with the
.NET debug adapter of [Passenger](https://github.com/Zaneris/passenger) 0.2.0 (MIT). No C# Dev Kit and no `vsdbg`,
so nothing here carries Visual Studio's licence terms, except the two closed Microsoft assemblies the Roslyn package
ships (`Microsoft.VisualStudio.Telemetry`, `Microsoft.VisualStudio.Utilities.Internal`; Razor's MEF parts need them, and
the server runs with `--telemetryLevel off`).

## Build

Needs Node.js and the .NET 10 runtime (the server runs on the installed `dotnet`).

```bash
npm install
npm run fetch-server
```

The debugger is Passenger 0.2.0's, ported to .NET 10 (`debugger-port/net10.patch`), so it builds with the .NET 10 SDK
and runs on the installed .NET 10 runtime (17 MB instead of 100 MB self-contained):

```bash
powershell -File scripts/build-debugger.ps1
```

The port replaces the .NET 11 APIs Passenger uses: `ProcessStartInfo.StartSuspended` and `SafeProcessHandle.Resume`
(a suspended `CreateProcessW` with piped standard streams, then `ResumeThread`), `KillOnParentExit` (a kill-on-close
Windows job), and marks `IMetaDataTables2` unsafe for .NET 10's COM generator. Off Windows, `StartDetached` is dropped,
so children stay in the adapter's session; only Windows is tested.

## Use

- The first `.sln`/`.slnx` in the workspace loads (or set `csharpShooter.solution`).
- Debug with a `launch.json` entry of type `csharpshooter` (`program`, `args`, `cwd`, `env`, `stopAtEntry`,
  `justMyCode`, `console`; `attach` takes `processId`).
- `csharpShooter.razorViewsInDesignTime` (on by default) gives the server's Razor every `.cshtml` even when a project
  sets `RazorCompileOnBuild=false`; without it such views get no C# help at all. Only the server's design-time builds
  change.

## Test

Runs the checks in `test/suite.js` in a real editor against a real solution (written for a sample ASP.NET Core MVC solution):

```bash
EDITOR_EXE=/path/to/VSCodium.exe WORKSPACE=/path/to/solution npm test
```

`SKIP_DEBUG=1` skips the debugging check; `CHECKS_FILE=checks.json` replaces the checks.

## Not done

- HTML help inside `.cshtml` (HTML element/attribute completion, HTML formatting): Razor asks the client for it, and this
  extension answers empty. Tag helpers, components and C# come from Razor itself and work.
- Hot Reload (Passenger's `applyChanges` request), test explorer, solution view, NuGet: none.
