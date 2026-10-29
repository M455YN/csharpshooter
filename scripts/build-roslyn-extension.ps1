# Builds CSharpShooter's extension to the C# language server (roslyn-extension/: Passenger's Hot Reload and refactoring
# handlers, compiled against server/'s own assemblies, so npm run fetch-server first) into roslyn-extension/out, which
# extension.js passes to the server with --extension.
#   powershell -File scripts/build-roslyn-extension.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'roslyn-extension\out'
if (!(Test-Path (Join-Path $root 'server\Microsoft.CodeAnalysis.Features.dll'))) { throw "server/ is missing: npm run fetch-server first" }
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet build (Join-Path $root 'roslyn-extension\CSharpShooter.Roslyn.Extension.csproj') -c Release -o $out
if ($LASTEXITCODE) { throw "dotnet build failed" }
Get-ChildItem $out -Exclude CSharpShooter.Roslyn.Extension.dll | Remove-Item
Write-Host "C# server extension in $out"
