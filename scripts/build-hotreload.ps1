# Builds Hot Reload's half in the C# language server (hotreload-extension/: Passenger's Edit and Continue handlers,
# compiled against server/'s own assemblies, so npm run fetch-server first) into hotreload-extension/out, which
# extension.js passes to the server with --extension.
#   powershell -File scripts/build-hotreload.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'hotreload-extension\out'
if (!(Test-Path (Join-Path $root 'server\Microsoft.CodeAnalysis.Features.dll'))) { throw "server/ is missing: npm run fetch-server first" }
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet build (Join-Path $root 'hotreload-extension\CSharpShooter.HotReload.csproj') -c Release -o $out
if ($LASTEXITCODE) { throw "dotnet build failed" }
Get-ChildItem $out -Exclude CSharpShooter.HotReload.dll | Remove-Item
Write-Host "Hot Reload extension in $out"
