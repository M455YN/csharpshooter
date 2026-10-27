# Changelog

All notable changes to **CSharpShooter** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
