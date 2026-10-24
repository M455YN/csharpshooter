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

## Startup project and active profile (as Visual Studio)

As in VS 2026, the solution has a startup project and each project an active launch profile, kept where VS keeps them:
the startup project is read from VS's own `.vs/<solution>/v*/.suo` (so VS's choice carries over; a later change there
does too), then kept per workspace; the active profile is the project's `.csproj.user` `<ActiveDebugProfile>` (and
`<ActiveDebugFramework>` for a multi-targeted one), read and written as VS reads and writes it, so a choice holds in both.

- **Status bar**, as VS's toolbar: *$(project) WebApp* picks the startup project; *▷ WebApp Development* opens the
  start button's menu: *Rozpocznij* (F5), *Uruchom bez debugowania* (Ctrl+F5), the project's profiles, *Platforma (…)*
  for a multi-targeted project, *Właściwości debugowania …* (its `launchSettings.json`).
- **Solution Explorer**: the startup project says *projekt startowy*; *Ustaw jako projekt startowy* on a runnable
  project (an Exe or a web project; a class library gets VS's "cannot be run directly" message).
- **Run and Debug**: the entry *Projekt startowy (CSharpShooter)* (`"startupProject": true`) always runs the startup
  project with its active profile; select it once and F5 / Ctrl+F5 do what they do in VS. Ctrl+F5 runs the program
  without the debugger, in a terminal of its own, and opens the browser as F5 does.

Not yet: several startup projects at once (VS's `.slnLaunch` launch profiles).

## F5 (launch profiles)

Each runnable project's `Properties/launchSettings.json` profiles are in Run and Debug's list (".NET (CSharpShooter)"),
named `Project: Profile`; Solution Explorer → right-click a project → **Start Debugging...** picks one too, and F5 with
no `launch.json` runs the active file's project. As in Visual Studio, the project builds first (`dotnet build`, in a
task, with its errors in Problems), runs from MSBuild's `TargetPath` with the profile's environment variables,
`commandLineArgs` and `applicationUrl` (as `ASPNETCORE_URLS`), and when the profile has `launchBrowser` the browser opens
at `launchUrl` once the app listens: its port accepts a connection, or its console says "Now listening on". An
`IISExpress` profile runs on Kestrel at the IIS Express URLs (`iisSettings`), since IIS Express runs only under Visual
Studio. If the profile's port is taken before the start, a warning says so.

A notification at the bottom right says what is going on until the browser opens, as VS says it in its status bar:
*Kompilacja rozpoczęta…*, *Przywracanie pakietów NuGet…*, a project's own targets (*Contoso.Core: PreBuild…*, a gulp target),
*Kompilowanie X…*, *X — skompilowano*, with the errors and warnings so far, then *Kompilacja zakończyła się powodzeniem*,
*Uruchamianie z debugerem…* (or *bez debugowania*), *Czekanie, aż aplikacja zacznie nasłuchiwać (url)…*, *Otwieranie
przeglądarki…*. Its **Cancel** stops the build. The stages come from MSBuild's file log (`-flp`, normal verbosity, a temporary
file), read as it is written; the terminal keeps MSBuild's own output. Solution Explorer's Build and Rebuild show it too.

The Run and Debug dropdown lists only `launch.json`'s configurations (an extension's own wait behind *.NET
(CSharpShooter)...* in Select and Start Debugging), so CSharpShooter offers, once per workspace, to add the profiles to
`.vscode/launch.json` as entries like the one below; *Add Launch Profiles to Run and Debug* in the Command Palette adds
the missing ones at any time. `csharpShooter.launchProfilesInLaunchJson`: `ask` (default), `always`, `never`. The
file's other entries are left as they are.

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

### Search

A box above the tree, as VS's (*Przeszukaj: Solution Explorer (Ctrl+;)*; **Ctrl+;** goes to it). As you type, the tree
shows only the items whose names match, their folders and projects open, the matches highlighted; Enter or ↓ goes to
the first; Esc or ✕ brings the whole tree back; ⤢ (or the search icon on its title) takes the query to the full-screen search below. Names match as in VS: every word of the query in the name (`"a phrase"`
as one), case only when the query has a capital, and a single all-capitals word also by the name's letters in order
(`HC` finds `HomeController.cs`). They come from an index kept in memory, built once and then kept up to date by the
files created and deleted, so a search takes milliseconds.

▾ → **Szukaj w zawartościach plików** (`csharpShooter.solutionSearch.fileContents`, off by default as in VS) adds the
files whose text holds the query, its lines under them (click one to go there): ripgrep, the one the editor ships, over
the projects' folders without `bin`, `obj`, `node_modules` and binary files (about half a second on a solution of
10 000 files). VS adds classes and methods there, from its language services; this adds text.

Not like VS (yet): files a project includes from outside its folder or removes with `<Compile Remove>` show as on disk;
no drag and drop, rename, other item templates or NuGet manager; the search has no *Wyszukuj wśród elementów
zewnętrznych* (VS's External Dependencies) and no index saved between sessions. VS Code gives a view above the tree at
least 120 px, so the box has room below it (the result count goes there).

## Search (Ctrl+T, Ctrl+Shift+F)

Visual Studio 2026's code search (*Szukaj wszędzie*, Ctrl+T) and Find in Files (Ctrl+Shift+F, starting with the selected
text; ⤢ in the Solution Explorer's box with its query) in one editor tab, laid out as swiftfind's full-screen search, with VS's Polish texts:

- **Filters**, as VS's: *Kod* (files, types and members together, a few of each with *Pokaż więcej*), *Pliki (f:)*, *Typy
  (t:)*, *Elementy członkowskie (m:)*; `f:`, `t:`, `m:` typed before the query pick one. Then *Tekst* (Find in Files) and
  *Funkcje* (VS's Feature Search: the extensions' commands by title, and the query in Settings and in the Command Palette
  for VS Code's own). Files come from the Solution Explorer's index (the solution's files, at once), types and members
  from the language server (kind, containing type, file).
- **Options**: *Uwzględnij wielkość liter*, *Dopasuj całe wyrazy*, *Użyj wyrażeń regularnych* (none set: names match as in
  the Solution Explorer's search); **Szukaj w**: *Całe rozwiązanie*, *Bieżący projekt*, *Bieżący dokument*, *Wszystkie
  otwarte dokumenty*; **Typy plików** (`*.cs;*.cshtml`).
- **Results** as they come (text through the editor's ripgrep), Find in Files' grouped by file; ↑/↓ moves, Enter or
  a double click opens there, Esc closes. A long line shows from just before its match.
- **Preview** of the selected result beside or below the list, or hidden (*Przełącz podgląd pionowy / poziomy*, *Ukryj
  podgląd*), the line and its matches highlighted.
- **Summary** under them, as Find in Files': *Pasujące wiersze: N  Pasujące pliki: N  Łączna liczba przeszukanych
  plików: N* (or the count per filter), *Niekompletne wyniki* when cut at 5 000 lines or 500 items; *Ostatnie zapytania*
  when the box is empty.

Not like VS (yet): no replace, no syntax colours in the preview, no *Zaznaczenie* scope; Ctrl+T and Ctrl+Shift+F take
VS Code's Go to Symbol in Workspace and Search (rebind them in Keyboard Shortcuts to have those back).

## Task Runner Explorer

Under the Solution Explorer, after Visual Studio's (its labels are VS's Polish ones: *Eksplorator modułu uruchamiającego
zadania*): each gulpfile of the solution's projects with its tasks (gulp's own `--tasks-simple`) and bindings, and each
`package.json` with scripts.

- ▶ / **Uruchom** runs a task in a terminal of its own, as VS runs it: `node_modules\.bin` first on `PATH`, gulp with
  `--color`. ■ / **Zatrzymaj** stops it. A run ends with "Zadanie X zakończone z kodem zakończenia N" in the
  *Eksplorator modułu uruchamiającego zadania* output.
- **Powiązania** (right-click a task) checks the events it is bound to and toggles them; under *Powiązania* in the tree, a
  bound task moves up or down or is removed (**Przenieś w górę / w dół / Usuń**), as in VS's Bindings tab. The
  gulpfile's `/// <binding ... />` line is written as VS writes it, its BOM and line endings kept.
- *Otwarcie projektu* (ProjectOpened) bindings start as the workspace opens (`csharpShooter.taskRunner.projectOpenBindings`,
  on), except a task `.vscode/tasks.json` already starts then (`runOn: folderOpen`, the same gulp task in the same folder,
  `task.allowAutomaticTasks` not off): that one is left to it, so a watcher never runs twice. A run started elsewhere
  (tasks.json, Run Task) shows as *uruchomione* in the tree and stops from it. *Przed kompilacją / Po kompilacji / Oczyszczanie* run around CSharpShooter's builds (F5, Solution Explorer) when
  `csharpShooter.taskRunner.buildBindings` is on: off by default, since a project that runs gulp from its `.csproj` when
  built outside Visual Studio (as the sample app does) would run it twice.

Not like VS: Grunt, output parsed into Problems (VS's JSHint listeners), a console tab per run.

## Test

Runs the checks in `test/suite.js` in a real editor against a real solution (written for a sample ASP.NET Core MVC solution):

```bash
EDITOR_EXE=/path/to/VSCodium.exe WORKSPACE=/path/to/solution npm test
```

`SKIP_DEBUG=1` skips the debugging check (`SKIP_SEARCH`, `SKIP_EVERYWHERE`, `SKIP_LAUNCH`, `SKIP_TASK_RUNNER`, `SKIP_MICROSOFT` the others); `CHECKS_FILE=checks.json` replaces the checks. The checks name a sample
solution (`WebApp`, `Contoso.Core`, `Contoso.Lobby`, ...); `NAMES_FILE=names.json`, ordered pairs such as
`[["WebApp Development", "My Profile"], ["WebApp", "MyWeb"], ["Contoso", "MyCompany"]]`, puts your solution's names in
their place.

## Not done

- HTML help inside `.cshtml` (HTML element/attribute completion, HTML formatting): Razor asks the client for it, and this
  extension answers empty. Tag helpers, components and C# come from Razor itself and work.
- Hot Reload (Passenger's `applyChanges` request), test explorer, solution view, NuGet: none.
