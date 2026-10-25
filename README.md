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

The debugger is Passenger's, its 0.2.0 release (tag `v0.2.0`, commit `4265c9f`, which the script fetches), ported to
.NET 10 (`debugger-port/net10.patch`), so it builds with the .NET 10 SDK and runs
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
- While the server starts and loads it, a notification at the bottom right and a spinner in the status bar say so
  (*Uruchamianie serwera C#…*, *Wczytywanie rozwiązania X (5 projektów)… 12 s*), as VS says it is loading the solution;
  once the projects are loaded the status bar says *Rozwiązanie X wczytane w N s: podpowiedzi C#, F12 i Razor gotowe*.
  On a slow machine that is where C# help, F12 and Razor are until then.
- Debug with a `launch.json` entry of type `csharpshooter` (`program`, `args`, `cwd`, `env`, `stopAtEntry`,
  `justMyCode`, `console`; `attach` takes `processId`).
- While debugging, a `DataTable`, `DataSet`, `DataView`, an array or a collection (`List<T>`, `IEnumerable<T>`,
  `Dictionary<K, V>`…) has a magnifier beside it in Variables and Watch (and a *Wizualizator* entry in their context
  menu), as Visual Studio's DataSet and IEnumerable visualizers: its rows in a table read from the stopped program a page
  (200 rows) at a time as it is scrolled (a collection's: a column per property of its element, or one *Value* column
  for numbers, strings and dates), *Tabela:* to pick a DataSet's table, *Filtruj*, sorting by a header
  (*Rosnąco*/*Malejąco*), *Kopiuj* / *Kopiuj wszystko* (tab-separated), *Eksportuj do pliku CSV...* and *Eksportuj do
  programu Excel...* (an .xlsx, numbers as numbers, opened with what opens .xlsx). A DataTable's cell is edited as in VS:
  double-click, Enter sets it in the program (converted to the column's type; empty is DBNull), a value the column cannot
  take is refused with the program's error. It evaluates C# in the frame (one LINQ expression a page, row by row where
  that fails) and loads System.Linq and System.Data.Common into the program first if it has not. Not like VS (yet): a
  collection's cells are not edited, and a property holding an object shows its text rather than expanding.
- While debugging, an EF Core query (a `DbSet`, a LINQ query over one) opened in Variables or a watch shows a `SQL` row:
  the SQL it would run, read only as it is opened.
- `csharpShooter.razorViewsInDesignTime` (on by default) gives the server's Razor every `.cshtml` even when a project
  sets `RazorCompileOnBuild=false`; without it such views get no C# help at all. Only the server's design-time builds
  change.
- `.cshtml` and `.razor` open as `aspnetcorerazor` (Razor's grammar), as Visual Studio and Passenger open them, so Razor's
  own completion answers there, not C#'s: `-` in `asp-for` or a tag helper's `icon-name` goes on typing the name instead
  of taking the first item, `@`, `=`, `"` and a space in a tag open the list, and it also comes inside an attribute's
  quotes (`asp-for="Lo…"`). Enter among a tag's attributes opens it as a space does (Razor is asked as for a space on
  the new line; in markup or C#, where it answers nothing, no list opens). `.cs` files keep Roslyn's.
- English and Polish: `csharpShooter.uiLanguage` (`auto`, `en`, `pl`) sets the language of CSharpShooter's own texts
  (notifications, status bar, Solution Explorer, Search, Publish, the visualizer, Task Runner Explorer), the Polish ones
  being Visual Studio's own Polish words; `auto` follows VS Code's display language. Command titles, view names and the
  settings' descriptions always follow VS Code's display language (`package.nls.json`, `package.nls.pl.json`), as VS Code
  localizes them. The texts are in `l10n/pl.json`; `npm run check-l10n` says whether each has its Polish. The debugger's
  messages a user sees (a launch or attach that fails, a breakpoint that will not be hit, the Debug Console's lines,
  failed evaluations, data breakpoints) follow it too: the adapter runs inline and `debug-l10n.js` matches Passenger's
  English texts as they pass; its log and the compiler's own diagnostics stay English.

## Startup project and active profile (as Visual Studio)

As in VS 2026, the solution has a startup project and each project an active launch profile, kept where VS keeps them:
the startup project is read from VS's own `.vs/<solution>/v*/.suo` (so VS's choice carries over; a later change there
does too), then kept per workspace; the active profile is the project's `.csproj.user` `<ActiveDebugProfile>` (and
`<ActiveDebugFramework>` for a multi-targeted one), read and written as VS reads and writes it, so a choice holds in both.

- **Status bar**, as VS's standard toolbar, left to right: *Zapisz wszystko*; *Debug ▾* (*Konfiguracje rozwiązania*, the
  .sln's own, e.g. a solution's "debug app"); *Any CPU ▾* (*Platformy rozwiązania*); *$(project) WebApp* picks the
  startup project; *▷ WebApp Development* opens the start button's menu: *Rozpocznij* (F5), *Uruchom bez debugowania*
  (Ctrl+F5), the project's profiles, *Platforma (…)* for a multi-targeted project, *Właściwości debugowania …* (its
  `launchSettings.json`); then *Uruchom bez debugowania* and *Uruchom ponownie* (grey until something runs). The
  configuration and platform go to F5's build and to the Solution Explorer's Build / Rebuild, each project's mapped as the
  .sln maps it (`{guid}.<cfg>|<platform>.ActiveCfg`), as VS builds; a launch.json entry's own `configuration` wins.
- **Uruchom ponownie** (the status bar's ↻, Ctrl+Shift+F5), as VS's: the app under the debugger is ended first, a start
  still building is cancelled, an app run with Ctrl+F5 (or left running by an earlier start of the project) is stopped,
  and only then is it built and started again. VS Code's own restart on the debug toolbar builds while the app still
  runs; use this one.
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

With a solution in the workspace the side bar opens on it, as VS opens on its Solution Explorer. Its icon comes after
VS Code's own (an extension cannot put it first); dragged above the Explorer once, it stays there.

A tab of its own in the activity bar, after Visual Studio's Solution Explorer, in its colours (purple solution, green
C# projects, blue web projects and packages, yellow folders): the solution (`.sln` or `.slnx`) with its solution
folders and projects; each project with **Dependencies** (frameworks, project references, packages, read from the
project file with its commented-out references left out) and its files as VS shows them: `bin`, `obj`, `node_modules`
and `*.user` hidden, related files nested (`Foo.cshtml.cs` under `Foo.cshtml`, `appsettings.Development.json` under
`appsettings.json`, `x.min.js` under `x.js`, `Resources.Designer.cs` under `Resources.resx`). Click opens a file;
the title bar has **Sync with Active Document** and **Refresh**; a project's or the solution's context menu has
Build, Rebuild, Clean (`dotnet build/clean` in a task), Edit Project File, Open in Terminal, Open Folder in File
Explorer and Copy Full Path. It follows files created and deleted on disk.

**Opublikuj...** (a project's menu) opens VS 2026's Publish page in an editor tab: the profile to publish with, *Nowy
profil*, *Opublikuj*, *Więcej akcji* (*Zmień nazwę*, *Usuń*), how the last publish ended (*Otwórz folder*), and *Ustawienia
profilu* as VS's settings dialog has them (*Konfiguracja*, *Struktura docelowa*, *Tryb wdrożenia*, *Docelowe środowisko
uruchomieniowe*, *Lokalizacja docelowa*, and *Usuń istniejące pliki*, *Utwórz pojedynczy plik*, *Włącz kompilację
ReadyToRun*, *Przytnij nieużywany kod*, greyed as VS greys them), saved into the .pubxml element by element. It publishes to
a folder as Visual Studio does: one of its profiles
(`Properties/PublishProfiles/*.pubxml`, VS's own) or *Nowy profil*, which asks for the folder and writes a
`FolderProfile.pubxml` as VS writes one; then `dotnet publish` with it in a task, its stages at the bottom right as a
build's. The profile's `LastUsedBuildConfiguration` and `TargetFramework` go on the command line (`-c`, `-f`): the SDK
takes neither from a profile (a multi-targeted project fails without `-f`). It ends with VS's *Publikowanie zakończyło
się powodzeniem.* and the folder as MSBuild resolves it, with *Otwórz folder*. Not like VS (yet): only folder profiles
(no Azure, FTP, Web Deploy).

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

## Visual Studio 2026 look

Two colour themes, *Visual Studio 2026 Dark* and *Visual Studio 2026 Light* (File > Preferences > Theme > Color Theme),
made from VS 2026's own theme files by `scripts/make-themes.js`: the shell's colours (title bar, tabs with the accent line,
tool windows, menus, status bar grey and red while debugging, buttons, text boxes, selection) from `Theme.Dark.pkgdef` /
`Theme.Light.pkgdef`, the editor's from `EditorColors.pkgdef` and VS's Fonts and Colors defaults, C# classified as VS
classifies it (classes, interfaces, structs, methods, parameters, locals, control keywords) through the server's semantic
tokens, Razor and HTML as VS shows them.

```bash
node scripts/make-themes.js "C:/Program Files/Microsoft Visual Studio/18/Community"
```

Not like VS: VS Code's own layout (activity bar, no toolbar row) stays; the colourful themes (Cool Slate, Juicy Plum...).

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

`SKIP_DEBUG=1` skips the debugging check (`SKIP_SEARCH`, `SKIP_EVERYWHERE`, `SKIP_LAUNCH`, `SKIP_TASK_RUNNER`, `SKIP_MICROSOFT`, `SKIP_THEMES` the others); `CHECKS_FILE=checks.json` replaces the checks. The checks name a sample
solution (`WebApp`, `Contoso.Core`, `Contoso.Lobby`, ...); `NAMES_FILE=names.json`, ordered pairs such as
`[["WebApp Development", "My Profile"], ["WebApp", "MyWeb"], ["Contoso", "MyCompany"]]`, puts your solution's names in
their place.

## Not done

- HTML help inside `.cshtml` (HTML element/attribute completion, HTML formatting): Razor asks the client for it, and this
  extension answers empty. Tag helpers, components and C# come from Razor itself and work.
- Hot Reload (Passenger's `applyChanges` request), test explorer, solution view, NuGet: none.
