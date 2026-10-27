# Builds the Test Explorer's bridge to VSTest (testbridge/: vstest.console driven through VSTest's translation layer, as
# Visual Studio's Test Explorer drives it) into testbridge/out, where test-engine.js starts it.
#   powershell -File scripts/build-testbridge.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'testbridge\out'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet publish (Join-Path $root 'testbridge\CSharpShooter.TestBridge.csproj') -c Release -o $out
if ($LASTEXITCODE) { throw "dotnet publish failed" }
Get-ChildItem $out -Filter *.pdb | Remove-Item
Write-Host "Test bridge in $out"
