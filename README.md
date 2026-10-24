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

The debugger is Passenger's, from its `0.2.0` branch at commit `b4a6eb1` (a branch that moves on, so the script fetches
that commit, not the branch), ported to .NET 10 (`debugger-port/net10.patch`), so it builds with the .NET 10 SDK and runs
on the installed .NET 10 runtime (17 MB instead of 100 MB self-contained):

```bash
powershell -File scripts/build-debugger.ps1
```

The port replaces the .NET 11 APIs Passenger uses: `ProcessStartInfo.StartSuspended` and `SafeProcessHandle.Resume`
(a suspended `CreateProcessW` with piped standard streams, then `ResumeThread`), `KillOnParentExit` (a kill-on-close
Windows job), and marks `IMetaDataTables2` unsafe for .NET 10's COM generator. Off Windows, `StartDetached` is dropped,
so children stay in the adapter's session; only Windows is tested.

## Package and install

With `server/` and `debugger/` in place (above):

```bash
npm run package
```

This gives `csharpshooter-win32-x64-<version>.vsix` (about 70 MB: the server, the debugger and the extension's
`node_modules`; `.vscodeignore` leaves out the tests, scripts, the port and `.pdb` files). It is a `win32-x64` package,
since the server and the debugger in it are built for Windows x64; for another system, run
`node scripts/fetch-server.js 5.11.0 <rid>` and `scripts/build-debugger.ps1 -Runtime <rid>`, and change `--target` in
`package.json`'s `package` script.

Install it in VSCodium:

```bash
codium --install-extension csharpshooter-win32-x64-0.0.3.vsix
```

or in VS Code:

```bash
code --install-extension csharpshooter-win32-x64-0.0.3.vsix
```

or from the editor: Extensions → `…` → **Install from VSIX...**. Then reload the window.

Before you use it, disable the other C# extensions **for the workspace**, since two C# language servers on the same
files answer twice and clash: Microsoft's C# (`ms-dotnettools.csharp`) and C# Dev Kit, and C# Dev Tools
(`jakubkozera.csharp-dev-tools`). An installed copy is tested like the sources:
`EXTENSION_PATH=<its folder under the extensions folder> npm test`.

## Use

- The first `.sln`/`.slnx` in the workspace loads (or set `csharpShooter.solution`).
- Debug with a `launch.json` entry of type `csharpshooter` (`program`, `args`, `cwd`, `env`, `stopAtEntry`,
  `justMyCode`, `console`; `attach` takes `processId`).
- While debugging, an EF Core query (a `DbSet`, a LINQ query over one) opened in Variables or a watch shows a `SQL` row:
  the SQL it would run, read only as it is opened.
- `csharpShooter.razorViewsInDesignTime` (on by default) gives the server's Razor every `.cshtml` even when a project
  sets `RazorCompileOnBuild=false`; without it such views get no C# help at all. Only the server's design-time builds
  change.

## F5 (launch profiles)

Each runnable project's `Properties/launchSettings.json` profiles are in Run and Debug's list (".NET (CSharpShooter)"),
named `Project: Profile`; Solution Explorer → right-click a project → **Start Debugging...** picks one too, and F5 with
no `launch.json` runs the active file's project. As in Visual Studio, the project builds first (`dotnet build`, in a
task, with its errors in Problems), runs from MSBuild's `TargetPath` with the profile's environment variables,
`commandLineArgs` and `applicationUrl` (as `ASPNETCORE_URLS`), and when the profile has `launchBrowser` the browser opens
at `launchUrl` once the app listens: its port accepts a connection, or its console says "Now listening on". An
`IISExpress` profile runs on Kestrel at the IIS Express URLs (`iisSettings`), since IIS Express runs only under Visual
Studio. If the profile's port is taken before the start, a warning says so.

In `launch.json`:

```json
{ "name": "WebApp Development", "type": "csharpshooter", "request": "launch",
  "project": "${workspaceFolder}/WebApp/WebApp.csproj", "launchProfile": "WebApp Development" }
```

(`configuration`, `build: false`, `launchBrowser: false`, `env` and `args` override the profile.)

### launch.json written for Microsoft's debuggers

F5 on a configuration of type `coreclr` (Microsoft's C# extension) or `dotnet` (C# Dev Kit) runs it on CSharpShooter's
debugger when the extension that owns the type is not installed or is disabled (`csharpShooter.runMicrosoftConfigurations`:
`auto`, the default; `always`; `never`), so an existing `launch.json` works unchanged:

- `coreclr` launch: `program`, `args`, `cwd`, `env`, `envFile`, `stopAtEntry`, `justMyCode`, `console`, `preLaunchTask`;
  the `launchSettings.json` profile of the project in `cwd` as the C# extension applies it (`launchSettingsProfile`, else
  the first `Project` profile; `null` for none); `serverReadyAction` opens the browser once the app listens. `coreclr`
  attach: `processId`.
- `dotnet`: `projectPath` and `launchConfigurationId` (`TargetFramework=…;Profile`) run as CSharpShooter's own F5 on that
  project and profile.
- Left out, and named in the CSharpShooter output: `sourceFileMap`, `symbolOptions`, `requireExactSource`,
  `sourceLinkOptions`, `logging` and the like. `pipeTransport` (a remote machine or container) is refused.

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
