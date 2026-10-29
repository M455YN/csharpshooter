# CSharpShooter for VSCodium

A prototype extension: C# and Razor (`.cs`, `.cshtml`, `.razor`) from Microsoft's
[`roslyn-language-server`](https://www.nuget.org/packages?q=roslyn-language-server) (MIT), debugging with the
.NET debug adapter of [Passenger](https://github.com/Zaneris/passenger) (MIT, its main on the way to 0.2.3). No C# Dev Kit and no `vsdbg`,
so nothing here carries Visual Studio's licence terms, except the two closed Microsoft assemblies the Roslyn package
ships (`Microsoft.VisualStudio.Telemetry`, `Microsoft.VisualStudio.Utilities.Internal`; Razor's MEF parts need them, and
the server runs with `--telemetryLevel off`).

## Build

Needs Node.js and the .NET 10 runtime (the server runs on the installed `dotnet`).

```bash
npm install
npm run fetch-server
npm run fetch-sqltools
npm run fetch-monaco
```

`fetch-monaco` puts Microsoft's Monaco editor (MIT) into `media/monaco` for the SQL editor page (below under *SQL*),
without its TypeScript, CSS, HTML and JSON workers (6.6 MB). `fetch-sqltools` downloads Microsoft's SQL Tools Service (below under *SQL*) into `sqltools/`, without its own copy of
.NET, the migration tool and the texts of languages other than English and Polish (139 MB instead of 337 MB).

The debugger is Passenger's, its main on the way to 0.2.3 (commit `7358d41` of 2026-10-29, which the script fetches:
0.2.2 and the fixes since, among them pointers shown as their address and type, C# 15 unions as the value they hold,
steps over an `await` in .NET 11's runtime-async methods, clearer word on an evaluation that does not end, with
`PASSENGER_WAIT_SCALE` to give a slow machine longer, and Hot Reload moving running frames to the new code), ported to .NET 10 (`debugger-port/net10.patch`), so it builds with the .NET 10 SDK and runs
on the installed .NET 10 runtime (17 MB instead of 100 MB self-contained):

```bash
powershell -File scripts/build-debugger.ps1
```

The Test Explorer's bridge to vstest.console (`testbridge/`, below under *Test Explorer*):

```bash
npm run build-testbridge
```

CSharpShooter's extension to the C# server (`roslyn-extension/`: Passenger's handlers for *Hot Reload* and the
*Refactorings* below), compiled against `server/`'s own assemblies, so after `npm run fetch-server`:

```bash
npm run build-roslyn-extension
```

The port replaces the .NET 11 APIs Passenger uses: `ProcessStartInfo.StartSuspended` and `SafeProcessHandle.Resume`
(a suspended `CreateProcessW` with piped standard streams, then `ResumeThread`), `KillOnParentExit` (a kill-on-close
Windows job), and marks `IMetaDataTables2` unsafe for .NET 10's COM generator. Off Windows, `StartDetached` is dropped,
so children stay in the adapter's session; only Windows is tested.

## Package and install

With `server/`, `sqltools/`, `media/monaco/` and `debugger/` in place (above):

```bash
npm run package
```

This gives `csharpshooter-win32-x64-<version>.vsix` (about 70 MB: the server, the debugger and the extension's code as
one bundle, `dist/extension.js`, which vsce has `npm run bundle` make first with esbuild; `.vscodeignore` leaves out the
sources, `node_modules`, the tests, scripts, the port and `.pdb` files). `npm test` bundles before it runs too. It is a `win32-x64` package,
since the server and the debugger in it are built for Windows x64; for another system, run
`node scripts/fetch-server.js 5.11.0 <rid>` and `scripts/build-debugger.ps1 -Runtime <rid>`, and change `--target` in
`package.json`'s `package` script.

GitHub Actions runs only for a pushed `v*` tag (`.github/workflows/release.yml`, below), and the same build without
publishing on demand (*Actions → Build → Run workflow*, with another server version if wanted): `.github/workflows/build.yml` on `windows-latest` installs Node 22
and the .NET 10 SDK, checks the texts (`npm run check-l10n`), downloads the server, builds the debugger from Passenger's
source with the port's patch, packages the `.vsix` and keeps it as the run's artifact (`csharpshooter-win32-x64`).

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
  menu; deeper down too, a field of a field: it is read by its whole expression, the parent cast to its runtime type and
  the member, as the debugger gives only the member's name there), as Visual Studio's DataSet and IEnumerable
  visualizers: its rows in a table read from the stopped program a page
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
- Visual Studio's keys, on by default (`csharpShooter.visualStudioKeybindings`; off gives VS Code's own back): the 51 of
  Microsoft's [Visual Studio Keymap](https://github.com/microsoft/vscode-vs-keybindings) 0.2.1 (Ctrl+Shift+B, Ctrl+B,
  Ctrl+Shift+F9, Ctrl+F10, Ctrl+K Ctrl+D, Ctrl+R Ctrl+R, Ctrl+L, Ctrl+Shift+L, Ctrl+-, Ctrl+Shift+-, Ctrl+W, Ctrl+Shift+S,
  Shift+Alt+arrows for a column selection...), with VS's *Go To All* (Ctrl+, and Ctrl+T) on CSharpShooter's Search, Find in
  Files (Ctrl+Shift+F) on its own and *Solution Explorer* (Ctrl+Alt+L) on its tree. Ctrl+Shift+F5 in a CSharpShooter
  session is its own Restart, not VS Code's. A person's own keybindings.json still wins over all of these.
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
  solution maps it (an .sln's `{guid}.<cfg>|<platform>.ActiveCfg`, an .slnx's rules), as VS builds; a launch.json entry's
  own `configuration` wins. Both lists end with *Menedżer konfiguracji...*, as VS's do.
- **Uruchom ponownie** (the status bar's ↻, Ctrl+Shift+F5), as VS's: the app under the debugger is ended first, a start
  still building is cancelled, an app run with Ctrl+F5 (or left running by an earlier start of the project) is stopped,
  and only then is it built and started again. VS Code's own restart on the debug toolbar builds while the app still
  runs; use this one.
- **Solution Explorer**: the startup project says *projekt startowy*; *Ustaw jako projekt startowy* on a runnable
  project (an Exe or a web project; a class library gets VS's "cannot be run directly" message).
- **Run and Debug**: the entry *CSharpShooter* (`"startupProject": true`) always runs the startup
  project with its active profile; F5 / Ctrl+F5 run it whatever is selected, as in VS. Ctrl+F5 runs the program
  without the debugger, in a terminal of its own, and opens the browser as F5 does.

Not yet: several startup projects at once (VS's `.slnLaunch` launch profiles).

## F5 (launch profiles)

Each runnable project's `Properties/launchSettings.json` profiles are in Run and Debug's list (".NET (CSharpShooter)"),
named `Project: Profile`; Solution Explorer → right-click a project → **Start Debugging...** picks one too, and F5 with
no `launch.json` runs the active file's project. As in Visual Studio, the project builds first (`dotnet build`, in a
task, with its errors in Problems), runs from MSBuild's `TargetPath` with the profile's environment variables,
`commandLineArgs` and `applicationUrl` (as `ASPNETCORE_URLS`), and when the profile has `launchBrowser` the browser opens
at `launchUrl` once the app listens: its port accepts a connection, or its console says "Now listening on". If the
profile's port is taken before the start, a warning says so.

An `IISExpress` profile runs under IIS Express, as Visual Studio runs it, when IIS Express is installed
(`C:\Program Files\IIS Express\iisexpress.exe`):

- **The site.** It goes into the solution's `.vs/<solution>/config/applicationhost.config`, the file VS writes, or one made
  from IIS Express's template. The site keeps the name and id VS gave it. Its bindings come from
  `iisSettings.iisExpress` (`applicationUrl`, `sslPort`). Its `windowsAuthentication` and `anonymousAuthentication` come
  from `iisSettings`, so Windows authentication (Negotiate/NTLM) is IIS's, as under VS.
- **The app.** IIS Express reads the project folder's `web.config`, which hands requests to `AspNetCoreModuleV2`. VS writes
  this file when it is missing, and so does CSharpShooter, using the project's `AspNetCoreHostingModel`. The module starts
  the built app from `LAUNCHER_PATH`/`LAUNCHER_ARGS`, and the app gets the profile's environment variables.
- **Starting it.** `iisexpress.exe /config:… /site:… /apppool:…` runs in a task, whose terminal is IIS Express's console.
- **Debugging.** The debugger attaches to `iisexpress.exe` for in-process hosting. It takes hold as the module starts the
  runtime on the first request, so breakpoints in `Startup` are hit. For out-of-process hosting, it attaches to the
  module's child process, once a request (with the Windows user's credentials) has started it.
- **Stopping.** Stopping debugging ends IIS Express. The next start also stops an IIS Express still running the site,
  since an in-process app holds the build's files.

Without IIS Express (or with `CSHARPSHOOTER_NO_IISEXPRESS=1`), the profile runs on Kestrel at the IIS Express URLs.
Kestrel does nothing with `iisSettings`, so Windows authentication then needs the app's own handler: the
`Microsoft.AspNetCore.Authentication.Negotiate` package with
`services.AddAuthentication(NegotiateDefaults.AuthenticationScheme).AddNegotiate()`.

A notification at the bottom right says what is going on until the browser opens, as VS says it in its status bar:
*Kompilacja rozpoczęta…*, *Przywracanie pakietów NuGet…*, a project's own targets (*Contoso.Core: PreBuild…*, a gulp target),
*Kompilowanie X…*, *X — skompilowano*, with the errors and warnings so far, then *Kompilacja zakończyła się powodzeniem*,
*Uruchamianie z debugerem…* (or *bez debugowania*), *Czekanie, aż aplikacja zacznie nasłuchiwać (url)…*, *Otwieranie
przeglądarki…*. Its **Cancel** stops the build. The stages come from MSBuild's file log (`-flp`, normal verbosity, a temporary
file), read as it is written; the terminal keeps MSBuild's own output. Solution Explorer's Build and Rebuild show it too.

With nothing changed since its last build in this window, a start builds nothing (*Kompilacja: aktualne, nic do
skompilowania*), as Passenger 0.2.1 launches and VS's fast up-to-date check skips a build. Nothing changed means the
same SDK, configuration, platform and framework. It also means the same files in the folders of the project and of every
project it references (not `bin`, `obj`, `node_modules`, dot folders, `.csproj.user` and `launchSettings.json`), the same
`.props`, `.targets`, `global.json` and `NuGet.config` above them, and the same Git HEAD. Finally, the files the build
listed in `FileListAbsolute.txt` must be as it left them. Files are stamped after the build, since a project's own targets
may rewrite its sources as it builds (a gulp copy, a build date). A file a build rewrote is compared by its bytes, so the
same copy again is no change. A file saved during the build makes the next start build again. `DisableFastUpToDateCheck`
is passed over: VS reads it, but a project that sets it only wants its build steps on every build, which a start with
nothing changed has no need of. A start while another build runs (the Solution Explorer's, another start's, a
`tasks.json` `dotnet build`, the NuGet page's) waits for it to end (*Oczekiwanie na zakończenie trwającej kompilacji…*),
then checks. A Build or Rebuild in the Solution Explorer that succeeds counts as a start's own build (as Passenger 0.2.3's
launch after a Build), so F5 right after it builds nothing.

The Run and Debug dropdown lists only `launch.json`'s configurations (an extension's own wait behind *.NET
(CSharpShooter)...* in Select and Start Debugging), so CSharpShooter offers, once per workspace, to add one entry to
`.vscode/launch.json`, first: *CSharpShooter*, VS's start button. It runs the startup project with
its active profile, chosen from the status bar's start button, whose list has only the startup project's profiles, as
VS's has. F5 and Ctrl+F5 run it whatever Run and Debug has selected (VS Code gives an extension no way to select an
entry there), as in VS; while debugging F5 continues, and with no .NET project they do what VS Code's own do. *Add the Startup Project to Run and Debug* in the Command Palette adds it at any time;
`csharpShooter.launchProfilesInLaunchJson`: `ask` (default), `always`, `never`. The projects' profiles are not
written there (the other projects' stay under *.NET (CSharpShooter)...*), and the file's other entries are left as they
are. A profile of any project can still be an entry of its own, written by hand:

```json
{ "name": "WebApp Development", "type": "csharpshooter", "request": "launch",
  "project": "${workspaceFolder}/WebApp/WebApp.csproj", "launchProfile": "WebApp Development" }
```

(`configuration`, `build: false`, `launchBrowser: false`, `env` and `args` override the profile.)

A profile with an `https` URL first has ASP.NET Core's HTTPS development certificate checked, once a window session,
as Visual Studio 2026 does (`dotnet dev-certs https --trust --check`): installed when there is none, and when it is not
trusted VS's own question, *Ustawianie certyfikatu SSL programu ASP.NET Core jako zaufanego*, with *Tak* (`dotnet dev-certs
https --trust`, after Windows' own prompt) and *Nie pytaj mnie ponownie* (`csharpShooter.askToTrustDevCertificate`: false).

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

## Hot Reload

Edits to `.cs`, `.razor` and `.cshtml` files saved while the program runs under the debugger (F5) go into it without a
restart, paused or running, as Visual Studio's Hot Reload on save. On by default for a Debug build; `"hotReload": false`
in a `launch.json` configuration turns it off. It is Passenger's way: Roslyn's own Edit and Continue service, in the C#
server through Passenger's handlers (`roslyn-extension/`, loaded with the server's `--extension`), compares the
solution as the editors have it with what was built and emits the deltas; the debugger applies them (`applyChanges`).
The status bar says what came of each save.

- An edit the runtime cannot take while the program runs (Roslyn's rude edits: a signature changed under callers, a
  field added to a struct, and the like) is listed in Problems (source *Hot Reload*) with *Uruchom ponownie* to restart;
  code that does not compile is applied once it does.
- An IIS Express profile gets it too, for the modules the app loads after the debugger attaches.
- The open page does not reload itself yet: refresh it in the browser.

## Refactorings

The refactorings Visual Studio 2026 asks options for, with its names and keys, made by Passenger's handlers in the C#
server (`roslyn-extension/`): Ctrl+. offers those that apply at the caret, the editor's menu has them under
*Refaktoryzuj*, and each is one edit Ctrl+Z takes back.

- *Zmień sygnaturę...* (Ctrl+R, Ctrl+O or Ctrl+R, Ctrl+V): the signature as one line to edit (`double Area(double
  scale, int times)`): parameters reordered, removed, renamed or added, the method renamed, its return type changed;
  a new parameter asks the value every call passes (*Wartość miejsca wywołania*). The declaration, its overrides and
  implementations, and every call change; a use the new signature no longer fits is named, not changed.
- *Wyodrębnij interfejs...* (Ctrl+R, Ctrl+I): the interface's name and members; a file of its own beside the type's,
  which then implements it.
- *Przenieś typ do {plik}.cs* and *Przenieś do przestrzeni nazw...*: the type into a new file, or into another
  namespace with its users following.
- *Ściągnij składowe aż do typu bazowego...* and, as Passenger has it, *Wypchnij składowe w dół do typów
  pochodnych...*: the members chosen into the base type, or into each derived class chosen.

VS Code's input boxes and lists stand for VS's dialogs. Moving members asks VS's *Ustaw jako abstrakcyjny* for each: pulled
up into a class, abstract there and an `override` here; pushed down, left abstract here. As in VS, a file the change
reaches that is open in no tab is saved, and one open is left with its changes to save. `csharpShooter.previewRefactorings`
shows each change first in VS Code's Refactor Preview, ticked, as VS's *Podgląd zmian* (its one unticked line, *Podgląd
zmian*, is empty: it only opens the panel). A file just made (by *Przenieś typ*) joins the refactorings once the server has
loaded it into its project.

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

Files and folders are edited as in VS 2026, a file's nested files (`Foo.cshtml.cs` under `Foo.cshtml`) going with it:
*Zmień nazwę* (F2; a `.cs` file's class renamed with every use when VS's question, *Zmieniasz nazwę pliku. Czy chcesz także
zmienić nazwy…*, gets *Tak*), *Usuń* (Del, after VS's *Element „…” zostanie usunięty.*, into the Recycle Bin where VS deletes
for good), *Wytnij*, *Kopiuj* and *Wklej* (Ctrl+X, Ctrl+C, Ctrl+V; a copy beside its original is named as VS names it,
`Foo - kopiować.cs` in Polish), and drag and drop (a move; files dragged in from VS Code's Explorer or the system are
copied). Several items can be selected. Moves and renames are VS Code's own file edits, so open editors follow them;
what a rename changes in files open in no tab is saved, as VS saves it.

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

**Właściwości** (a project's menu, or Alt+Enter in the tree) opens VS 2026's project Properties window in an editor tab,
made as VS makes it, from the .NET project system's XAML rules (`rules/`, VS's Polish ones in `rules/pl/`): *Aplikacja*,
*Użycie globalne*, *Kompilacja*, *Pakiet*, *Analiza kodu*, *Debuguj*, *Zasoby*, *Ustawienia*, with their categories on the
left and *Wyszukaj właściwości* over all of them (a property's name, description and the rule's search terms, such as
TFM). Each property shows its description, its editor (a list, a box, a check box, a file with *Przeglądaj...*, the global
usings list) and, under a value with `$(...)` in it, what MSBuild makes of it; it is shown or hidden as its
VisibilityCondition says (VS's condition language: `has-evaluated-value`, `has-project-capability`, `ne`, `unevaluated`…).
Values are read from the project file and from one MSBuild evaluation (`dotnet msbuild -getProperty -getItem`); a change
is written to the project file at once, as VS writes it, and read back. The properties that depend on the configuration
(on *Kompilacja*) take *Konfiguracja* and *Platforma* at the top, into VS's `'$(Configuration)|$(Platform)'=='Debug|AnyCPU'`
group, or *Wszystkie konfiguracje*. Where VS's own code stands between a property and the project file, it does here too:
the target framework written as `TargetFramework` (`net10.0`, with the OS), *Wiele struktur docelowych* moving it to
`TargetFrameworks`, the resource and manifest choices, the package licence, `DefineConstants` on top of what the project
inherits, `ImplicitUsings` as `enable`/`disable`, build events as VS's `PreBuild`/`PostBuild` targets, `<Using>` items. Not
like VS (yet): a property the project file does not set shows its evaluated value (VS shows the unevaluated one wherever it
is set, e.g. `$(MSBuildProjectName)`); the Debug page's launch profiles, `.resx` and `.settings` open as files; the startup
object list is not filled from the code.

**Właściwości** under the Solution Explorer (F4 there with Visual Studio's keys, or *Okno właściwości* in the command
palette) is VS 2026's Properties window for what is selected: a file's *Akcja kompilacji*, *Kopiuj do katalogu
wyjściowego*, *Narzędzie niestandardowe*, *Przestrzeń nazw narzędzia niestandardowego*, *Nazwa pliku* and *Pełna ścieżka*;
a folder's and a project's own rows. They come from the project system's BrowseObject rules (`rules/`, VS's Polish in
`rules/pl/`), the build actions from its `ProjectItemsSchema` (*Brak*, *Zawartość*, *Kompilator C#*…), the values from
MSBuild's items. *Według kategorii* or *Alfabetycznie*, with the selected property's name and description at the bottom. A
change is written to the project file as VS writes it: a file the SDK's globs include gets `<None Update="x">` for its
metadata, `<None Remove="x" />` with `<Content Include="x" />` for another build action (its metadata moving along), and
going back takes them out again; a file the project includes itself is changed in place. Not like VS (yet): an item type
with no BrowseObject rule of its own (AdditionalFiles) shows None's rows; the solution has none.

**Menedżer konfiguracji...** (the solution's menu, or the end of the status bar's configuration and platform lists) opens
VS's Configuration Manager in an editor tab, with VS's own texts (msenvui.dll): *Aktywne konfiguracje rozwiązania* and
*Aktywne platformy rozwiązania* (the status bar's), then *Konteksty projektu*: each project's *Konfiguracja*, *Platforma*,
*Kompilacja* and *Wdróż* for them, with *Kompiluj wszystko* / *Wdróż wszystko*. Every list has *<Nowy...>* and
*<Edytuj...>*: *Nowa konfiguracja rozwiązania* / *Nowa platforma rozwiązań* (*Kopiuj ustawienia z*, *Utwórz nowe
konfiguracje projektu* / *platformy projektu*), *Nowa konfiguracja projektu* / *Nowa platforma projektu* (*Utwórz nowe
konfiguracje rozwiązania* / *platformy rozwiązania*), and *Edytuj …* to remove or rename one. The solution is written as
VS 2026 writes it, by the rules of Microsoft's vs-solutionpersistence (the library VS and dotnet read and write solutions
with): an .sln's whole `ProjectConfigurationPlatforms` matrix, an .slnx's fewest `<BuildType>`, `<Platform>`, `<Build>`
and `<Deploy>` rules over the defaults (`test/solution-config.js` checks them against `dotnet sln migrate`). A project's
own configurations and platforms go to its `<Configurations>` / `<Platforms>`; a new one copied from another gets that
one's `'$(Configuration)|$(Platform)'==…` groups, and a rename renames them. Not like VS (yet): project types other than
C#/VB/F#/C++ get the defaults; removing a project's configuration leaves its groups in the project file.

**Zarządzaj pakietami NuGet dla rozwiązania...** (the solution's menu; **Zarządzaj pakietami NuGet...** on a project)
opens VS 2026's *NuGet — rozwiązanie* in an editor tab, with VS's own texts (NuGet.PackageManagement.UI's resources):
*Przeglądaj*, *Zainstalowane* (⚠ when a version is vulnerable), *Aktualizacje* (their count), *Konsoliduj* (packages in
different versions across projects), the search box (**Ctrl+L**), *Uwzględnij wersję wstępną*, *Pokaż tylko podatne na
zagrożenia*, *Źródło pakietów* (the sources by their nuget.config names, *Wszystkie* searching them all at once) and its ⚙
(the user's NuGet.Config), the yellow *Masz zainstalowane narażone na ataki wersje pakietów: N.* (with *przestarzałe* when
some are deprecated), *Pakiety najwyższego poziomu (N)* and *Pakiety pośrednie (N)* (folded, as VS has them): each package
with its icon, *przez* its authors, its description, the installed version (⚠ when vulnerable or deprecated) and the
newer one under it, ↑ or ✓ on the icon. The selected package's pane has its projects to tick with their installed
versions (*Pośrednie* where another package brings it; installing it there makes it top-level), *Wersja:* (*Najnowsza
stabilna*), *Zainstaluj*/*Aktualizuj*, *Odinstaluj*, the package source mapping (*Mapowanie źródła pakietu jest
wyłączone.*, *Znaleziono...*, *Wymaga...* with *Konfiguruj*), *Opcje* → *Pokaż okno podglądu*, the deprecation (reason,
*Pakiet alternatywny*, a link that selects it) and advisories of the chosen version, then *Szczegóły pakietu* (description,
version, authors, licence, date published, downloads, project URL, tags, *Zależności* by framework) or *README* (rendered
by the editor's Markdown). *Zainstaluj*, *Aktualizuj* and *Odinstaluj* show VS's *Podgląd zmian* first (per project:
*Instalowanie:*, *Aktualizacje:*, *Odinstalowywanie:*), then *Akceptacja licencji* for a package that asks for it
(*Akceptuję*/*Odrzucam*); an unmapped package installed from one source gets its mapping in the nuget.config that holds
the mapping, as VS adds it. *Aktualizacje* also updates the ticked packages together.

What the solution has comes from each project's `obj/project.assets.json`, as restore wrote it: the packages each framework
references (top-level), the others its graph resolves (transitive), and NuGet Audit's NU1901–NU1904 warnings (the
vulnerable versions, with their advisories), read in milliseconds where `dotnet list package` takes seconds (a large web solution: 9 s,
21 s with `--vulnerable`; the page opens in about 3 s instead of 25). A project not restored, or changed since, is restored
first; `dotnet list package --format json` is the fallback. The sources and the package source mapping are read from the
nuget.config files `dotnet nuget config paths` names. Updates are the newest version the chosen source's search offers, as
in VS; icons, descriptions and *Przeglądaj* come from that search, a version's licence, date, dependencies, deprecation and
advisories from its registration (fetched behind the list for the installed packages), its README from the feed's README
address (`nuget-feeds.js`). A local folder source (flat `.nupkg` files, or NuGet's `id/version/` layout such as
VS's Offline Packages) is read from its `.nuspec` files, inside the `.nupkg` when not beside it (with its packed icon and
README). Changes are `dotnet add/remove package` in a task per project, its output in the task's terminal, run again (up to
three times, half a second apart) when another program had the project file open, as Passenger does; then `dotnet
restore` of the solution. Under central package management the SDK writes `Directory.Packages.props` (the pane says so).
Not like VS (yet): no *Zachowanie zależności* or uninstall options, licences asked for the package itself, not for
dependencies it brings; no credential providers for private feeds beyond what dotnet itself uses.

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
no rename, delete or move of projects and solution folders, no other item templates; the search has no *Wyszukuj wśród elementów
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
- **Zamień w plikach** (Ctrl+Shift+H, or › beside the box), VS's Replace in Files: a *Zamień na* box, each line of the
  results showing its change (the match struck through, the replacement beside it; `$1`... with *Użyj wyrażeń
  regularnych*), *Zamień* on the selected line (or on the selected file's lines) and *Zamień wszystko* on every file
  found, after asking. One edit, undone with Ctrl+Z; the files that were not open are saved, as VS saves them, the open
  ones left modified.

Not like VS (yet): no syntax colours in the preview, no *Zaznaczenie* scope. Ctrl+T, Ctrl+Shift+F and Ctrl+Shift+H take
VS Code's Go to Symbol in Workspace, Search and Replace while `csharpShooter.visualStudioKeybindings` is on (below).

## Visual Studio 2026 look

Two colour themes, *Visual Studio 2026 Dark* and *Visual Studio 2026 Light* (File > Preferences > Theme > Color Theme),
made from VS 2026's own theme files by `scripts/make-themes.js`: the shell's colours (title bar, tabs with the accent line,
tool windows, menus, status bar grey and red while debugging, buttons, text boxes, selection) from `Theme.Dark.pkgdef` /
`Theme.Light.pkgdef`, the editor's from `EditorColors.pkgdef` and VS's Fonts and Colors defaults, C# classified as VS
classifies it (classes, interfaces, structs, methods, parameters, locals, control keywords) through the server's semantic
tokens, Razor and HTML as VS shows them. Properties and fields stay the colour of plain text, as in VS. Roslyn's own
token types (field, extension method, record, constant, control keyword...) are declared with VS Code's types as their
supertypes, so another theme (VSCodium's *Dark 2026*) colours them too, though in its own way: there locals and
properties are plain text and parameters orange.

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

## Test Explorer

*Eksplorator testów*, as Visual Studio 2026's, in the bottom panel beside the Output and Problems: the solution's test
projects' tests grouped Projekt → przestrzeń nazw → klasa (or by class, namespace, project, state, duration), the
counts, *Wyszukaj* with VS's filters, and the summary beside the tree. Tests are found and run the way VS finds and runs them:

- A VSTest project (Microsoft.NET.Test.Sdk with an xUnit, NUnit or MSTest adapter) goes to vstest.console of the
  solution's .NET SDK, driven through VSTest's translation layer (`VsTestConsoleWrapper`) by `testbridge/`, a small .NET
  program the extension talks to over stdin and stdout. Discovery gives each test's source file and line; a theory's or a
  parameterized test's rows are tests of their own.
- A Microsoft.Testing.Platform project (its `ProjectCapability` `TestingPlatformServer`, the capability VS looks at:
  xUnit v3, MSTest's runner, TUnit, NUnit's runner) is run as its own program in server mode (`--server --client-port`)
  and asked over JSON-RPC (`testing/discoverTests`, `testing/runTests`).
- **Uruchom** builds what it runs first, then shows results as they come, not when the run ends.
- **Debuguj** runs the same way under Passenger's debugger: VSTest starts the test host and asks for the debugger
  (`ITestHostLauncher3.AttachDebuggerToProcess`), which attaches to its process id; the test host runs nothing until the
  adapter has the breakpoints (its `configurationDone`). A Testing Platform program is attached to before it is asked to
  run. Stopping the debugger stops the run.

The bridge is built into `testbridge/out` (`npm run build-testbridge`, or `scripts/build-testbridge.ps1`; the workflows
build it before packaging). `CSHARPSHOOTER_VSTEST_LOG=<file>` keeps vstest.console's diagnostic log.

Not like VS: test discovery from source before a build (VS's Real-Time Discovery), playlists, code coverage, a test's
child processes under the debugger.

## .http files

An `.http` or `.rest` file is coloured as HTTP (REST Client's grammar) and has **Wyślij żądanie** above each request, as
Visual Studio 2026's HTTP editor has it (Ctrl+Alt+S at the cursor too). Requests are apart by `###`: a request line
(`GET {{host}}/items/1`), headers up to a blank line, a body after it. `@name = value` defines a file variable;
`{{name}}` puts it in, else the HTTP environment's value; `{{$guid}}`, `{{$randomInt 1 10}}`, `{{$timestamp}}`,
`{{$datetime iso8601}}` and `{{$processEnv NAME}}` are there too. The environments are `http-client.env.json` beside
the file or above it (with `http-client.env.json.user` overriding, and `$shared` in each), chosen from **env: <none>**
in the status bar (F6 with Visual Studio's keys). The response opens in the **Odpowiedź** panel beside the file: *Kod
stanu*, *Czas*, *Rozmiar*, and the *Treść* (JSON indented), *Nagłówki* and *Nieprzetworzone* tabs; a request still
running has *Anuluj*. The texts are VS's own (WebTools' Rest editor). Not like VS (yet): no request list (F4), no
Azure Key Vault or user secrets in environments.

## SQL

`.sql` files are [CSharpShooter SQL](sql/README.md)'s, an extension of its own built from `sql/` (SQL Tools Service and
Monaco would double this one's size): query windows as in SQL Server Management Studio 22 and Visual Studio 2026. The
first `.sql` file opened offers to install it (*Zainstaluj*, *Nie teraz*, *Nigdy*).

## Test

Runs the checks in `test/suite.js` in a real editor against a real solution (written for a sample ASP.NET Core MVC solution):

```bash
EDITOR_EXE=/path/to/VSCodium.exe WORKSPACE=/path/to/solution npm test
```

`SKIP_DEBUG=1` skips the debugging check (`SKIP_SEARCH`, `SKIP_EVERYWHERE`, `SKIP_NUGET`, `SKIP_LAUNCH`, `SKIP_TASK_RUNNER`, `SKIP_MICROSOFT`, `SKIP_THEMES`, `SKIP_PROPERTIES`, `SKIP_PROPERTIES_WINDOW`, `SKIP_CONFIGURATION_MANAGER`, `SKIP_HTTP` the others); `CHECKS_FILE=checks.json` replaces the checks. The checks name a sample
solution (`WebApp`, `Contoso.Core`, `Contoso.Lobby`, ...); `NAMES_FILE=names.json`, ordered pairs such as
`[["WebApp Development", "My Profile"], ["WebApp", "MyWeb"], ["Contoso", "MyCompany"]]`, puts your solution's names in
their place.

The `.sql` checks (`test/sql-suite.js`) need a SQL Server with a small database; the suite's header says which, e.g. on
LocalDB:

```bash
EDITOR_EXE=/path/to/VSCodium.exe WORKSPACE=/path/to/folder SUITE=test/sql-suite.js node test/runTest.js
```

## Not done

- HTML help inside `.cshtml` (HTML element/attribute completion, HTML formatting): Razor asks the client for it, and this
  extension answers empty. Tag helpers, components and C# come from Razor itself and work.
- A page in the browser reloaded after Hot Reload applies an edit (`dotnet watch` does it with its BrowserRefresh).
- *Add to Watch* and *Copy as Expression* on a member deeper than the frame's own (a field of a field) give the member's
  name alone, Passenger's `evaluateName` there, which the frame does not know. The magnifier builds the whole expression
  itself (`variable-paths.js`); the fix is to rewrite `evaluateName` in `variables` responses with it, in the inline
  adapter (`debug-l10n.js`).
