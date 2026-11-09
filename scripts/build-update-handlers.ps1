# Builds CSharpShooter's startup hook for a program debugged with Hot Reload (update-handlers/: Passenger's
# Passenger.UpdateHandlers, the program's MetadataUpdateHandlers called after each update) into update-handlers/out, which
# hot-reload.js names in the program's DOTNET_STARTUP_HOOKS.
#   powershell -File scripts/build-update-handlers.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'update-handlers\out'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet build (Join-Path $root 'update-handlers\CSharpShooter.UpdateHandlers.csproj') -c Release -o $out
if ($LASTEXITCODE) { throw "dotnet build failed" }
Get-ChildItem $out -Exclude CSharpShooter.UpdateHandlers.dll | Remove-Item
Write-Host "Update handlers' hook in $out"
