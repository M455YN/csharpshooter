# Changelog

All notable changes to **CSharpShooter** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-10-29

### Added

- Hot Reload: `.cs`, `.razor` and `.cshtml` edits saved while the program runs under the debugger go into it without a restart, as Visual Studio's Hot Reload on save (Roslyn's Edit and Continue through Passenger's handlers in the C# server, applied by the debugger). On for a Debug build; `"hotReload": false` turns it off. Edits the runtime cannot take are listed in Problems with *Uruchom ponownie*.
- F5 of a profile with an `https` URL asks to trust ASP.NET Core's HTTPS development certificate when it is not trusted, as Visual Studio 2026 asks (its words, *Tak* or *Nie pytaj mnie ponownie*), and installs it when there is none.
- Solution Explorer: *Zmień nazwę* (F2, a `.cs` file's class renamed with it when asked, as VS asks), *Usuń* (Del, into the Recycle Bin), *Wytnij*, *Kopiuj*, *Wklej* (Ctrl+X, Ctrl+C, Ctrl+V) and drag and drop for files and folders, their nested files going with them, as Visual Studio 2026 has them.
- Refactorings as in Visual Studio 2026, made by Passenger's handlers in the C# server: *Zmień sygnaturę...* (Ctrl+R, Ctrl+O / Ctrl+R, Ctrl+V), *Wyodrębnij interfejs...* (Ctrl+R, Ctrl+I), *Przenieś typ do pliku* and *Przenieś do przestrzeni nazw...*, *Ściągnij składowe aż do typu bazowego...* and Passenger's *Wypchnij składowe w dół...*, offered by Ctrl+. where they apply and in the editor's *Refaktoryzuj* menu; members moved can be made abstract (*Ustaw jako abstrakcyjny*), files open in no tab are saved as VS saves them, and `csharpShooter.previewRefactorings` shows the changes first in VS Code's Refactor Preview.

## [0.6.0] - 2026-10-28

### Added

- `.http` and `.rest` files as Visual Studio 2026's HTTP editor: *Wyślij żądanie* above each request (Ctrl+Alt+S), file variables, `{{$guid}}` and the other dynamic ones, `http-client.env.json` environments chosen from the status bar (F6), the response in an *Odpowiedź* panel (status code, time, size; body, headers, raw). REST Client's grammar colours them.
- `.sql` files as in SQL Server Management Studio 22 and Visual Studio 2026 come in [CSharpShooter SQL](https://github.com/M455YN/csharpshooter/blob/main/sql/CHANGELOG.md), an extension of its own (SQL Tools Service and Monaco would double this one's size); the first `.sql` file opened offers to install it (*Zainstaluj*, *Nie teraz*, *Nigdy*).

### Changed

- F5 right after a Build or Rebuild in the Solution Explorer builds nothing.
- The debugger is Passenger's main on its way to 0.2.3: pointers as their address and type, C# 15 unions as the value they hold, steps over an `await` in .NET 11's runtime-async methods, clearer word on an evaluation that does not end (`PASSENGER_WAIT_SCALE` gives a slow machine longer).
- GitHub Actions builds and publishes only for a pushed `v*` tag (CSharpShooter) or `sql-v*` tag (CSharpShooter SQL); the build without publishing runs on demand.

### Fixed

- A restore that lands while the projects load reaches the C# server, so their packages resolve in that window.
- Deleting many source files (a checkout of another branch) no longer stalls the C# server's answers: 300 files held the open file's next answer 158 s, now under 50 ms.

## [0.5.0] - 2026-10-28

### Added

- An `IISExpress` launch profile runs under IIS Express, as Visual Studio 2026 runs it, when IIS Express is installed. The site goes into the solution's `.vs/<solution>/config/applicationhost.config` (Visual Studio's own file) with the bindings of `iisSettings.iisExpress` and the `windowsAuthentication` and `anonymousAuthentication` of `iisSettings`, so Windows authentication (Negotiate/NTLM) works as under Visual Studio. The project folder's `web.config` hands requests to `AspNetCoreModuleV2`, which starts the built app with the profile's environment variables. The debugger attaches to `iisexpress.exe` (in-process hosting) as the runtime starts, so breakpoints in `Startup` are hit, or to the module's child process (out-of-process hosting). Stopping debugging ends IIS Express. Without IIS Express the profile still runs on Kestrel at the IIS Express URLs.

## [0.4.1] - 2026-10-27

### Changed

- The extension's code ships as one bundle, `dist/extension.js` (esbuild, `npm run bundle`, run by vsce before it packages), instead of 194 JavaScript files; the sources and `node_modules` stay out of the .vsix, which holds about 350 files fewer and no longer gets vsce's "you should bundle your extension" warning.

### Fixed

- The Configuration Manager no longer throws when it is refreshed after its tab was closed.

## [0.4.0] - 2026-10-27

### Added

- **Test Explorer** as in Visual Studio 2026, in the bottom panel: VSTest projects through vstest.console's translation layer and Microsoft.Testing.Platform projects in server mode, each test with its file and line, results as they come and theory rows as tests of their own. *Debug* attaches the debugger to the test host; *Run* first builds what it runs; *Cancel* stops a run, aborting the test host when it does not end within 2 s.
- Task Runner Explorer: a task started by `tasks.json` (`runOn: folderOpen`) has a "(running)" tab saying its output is in its terminal, with *Stop it and run it here* and *Show terminal*. A Project Open binding wins over such a run of the same gulp task.
- Task Runner Explorer: a Project Open watcher that gulp ended with an error in a file it watched (a plugin error nobody handles, such as terser's) starts again, its console tab keeping the error. Visual Studio runs the same command and leaves it ended.
- Each loading stage's time (the C# server, the projects, the Razor views) is written to the Output window.

### Changed

- Run and Debug as in Visual Studio: `launch.json` gets one entry, *CSharpShooter*, at the top, the same in English and Polish (an entry with the earlier name *Projekt startowy (CSharpShooter)* is renamed). It runs the startup project with its active profile, chosen from ▷ in the status bar. The projects' profiles are no longer written to `launch.json`; they stay under *.NET (CSharpShooter)...*.
- F5 and Ctrl+F5 always start the startup project, whatever Run and Debug has selected; while debugging F5 continues, and with no .NET project they do what VS Code's own commands do.
- While the solution loads (the C# server, the projects, the Razor views), starting and running tests are refused with a message naming the stage.
- Razor views are ready about 20% sooner: the C# server starts with `DOTNET_TieredPGO=0` (a value of the user's own environment wins).
- Task Runner Explorer is a tab of the bottom panel, as Visual Studio docks it (tabbed with the Output window). The tree on the left lists each gulpfile's tasks. The tabs on the right hold Bindings and a console for each task run, titled "<task> (running)". Each console shows Visual Studio's `cmd.exe /c gulp -b "<folder>" --color --gulpfile "<gulpfile>" <task>` command line and gulp's coloured output. A run is stopped with its whole process tree, and closing a running console asks first.

## [0.3.1] - 2026-10-27

### Changed

- The `repository`, `homepage` and `bugs` fields in `package.json` point at this repository, so the marketplaces link the extension to its source.

## [0.3.0] - 2026-10-27

### Added

- **Visual Studio 2026 look and behaviour** for the everyday parts of a solution: the Solution Explorer with its search (Ctrl+;), the startup project and launch profile kept as VS keeps them (`.suo`, `.csproj.user`), F5 and Ctrl+F5, Run and Debug launch profiles, and the status bar with the standard toolbar, configuration and platform.
- **Properties window** (F4) for a selected file, folder or project, with VS's categories and descriptions, written back to the project file as VS writes it.
- **Configuration Manager** in an editor tab, for the solution's and each project's configurations and platforms, with `.sln` and `.slnx` written as VS writes them.
- **NuGet: Manage Packages for Solution** in an editor tab, with installed, transitive and deprecated packages and NuGet Audit results.
- **Publish page** as VS's, with profiles, *Nowy profil*, *Opublikuj* and the last publish's outcome; folder profiles are written as VS writes them.
- **Full-screen search** (Ctrl+T, Ctrl+Shift+F) with VS's filters, scope and options, and **Replace in Files** (Zamień w plikach, Ctrl+Shift+H).
- **Debugger** built on Passenger for .NET 10: a DataTable, DataSet and DataView visualizer, collections shown as VS's IEnumerable visualizer, and a build and start progress notice at the bottom right.
- **Task Runner Explorer** with Project Open watchers and runs started outside the explorer.
- **Visual Studio Dark and Light colour themes**, and Visual Studio's keybindings by default (`csharpShooter.visualStudioKeybindings`).
- **English and Polish UI** (`csharpShooter.uiLanguage`, auto follows VS Code's language), with the Polish wording taken from VS's own.
- **References CodeLens** and Roslyn's Fix All scope picker.

### Changed

- A `.cs` file opened while the solution is still loading gets its colours as soon as the server has them.
- F5 with nothing changed builds nothing and waits for a build that is already running.
- The side bar opens on the Solution Explorer when the workspace has a solution.

### Fixed

- Runs started from the Task Runner show as running and stop from the Task Runner.
- A debugger disconnect that ends the program no longer fails on an event.
