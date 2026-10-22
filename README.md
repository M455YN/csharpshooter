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

## Solution Explorer

A tab of its own in the activity bar, after Visual Studio's Solution Explorer, in its colours (purple solution, green
C# projects, blue web projects and packages, yellow folders): the solution (`.sln` or `.slnx`) with its solution
folders and projects; each project with **Dependencies** (frameworks, project references, packages, read from the
project file with its commented-out references left out) and its files as VS shows them: `bin`, `obj`, `node_modules`
and `*.user` hidden, related files nested (`Foo.cshtml.cs` under `Foo.cshtml`, `appsettings.Development.json` under
`appsettings.json`, `x.min.js` under `x.js`, `Resources.Designer.cs` under `Resources.resx`). Click opens a file;
the title bar has **Sync with Active Document** and **Refresh**; a project's or the solution's context menu has
Build, Rebuild, Clean (`dotnet build/clean` in a task), Edit Project File, Open in Terminal, Open Folder in File
Explorer and Copy Full Path. It follows files created and deleted on disk.

Right-click a project or folder → **Add**:
- **New Folder...**
- **View (.cshtml)...**: `Name.cshtml` with `ViewData["Title"]`, in the folder (a project's `Views` when the project
  itself was clicked).
- **Controller (C#)...**: `NameController.cs` (the suffix added when missing), in the folder (a project's `Controllers`
  when the project was clicked). The base class is picked from those the project's controllers already use, most used
  first (`BaseController` in the sample app), or `Controller` / `ControllerBase` (an `[ApiController]`); its `using` comes from
  where the language server finds it. Namespace = `RootNamespace` + folders; file-scoped or block namespace and line
  endings follow the project's own files.

Not like VS (yet): files a project includes from outside its folder or removes with `<Compile Remove>` show as on disk;
no drag and drop, rename, other item templates, NuGet manager or startup project.

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
