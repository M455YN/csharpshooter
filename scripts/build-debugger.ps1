# Builds Passenger's debug adapter for .NET 10 into debugger/: clones the tag, applies debugger-port/net10.patch, publishes.
#   powershell -File scripts/build-debugger.ps1 [-Tag 0.2.0] [-Runtime win-x64]
param(
    [string]$Tag = '0.2.0',
    [string]$Runtime = 'win-x64'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$work = Join-Path ([IO.Path]::GetTempPath()) "passenger-$Tag-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$out = Join-Path $root 'debugger'

git clone --quiet --depth 1 --branch $Tag https://github.com/Zaneris/passenger $work
if ($LASTEXITCODE) { throw "git clone failed" }
try {
    git -C $work apply --whitespace=nowarn (Join-Path $root 'debugger-port\net10.patch')
    if ($LASTEXITCODE) { throw "the patch does not apply to Passenger $Tag" }
    # The .NET 10 SDK, and lock files restored afresh for net10.0.
    Set-Content -Encoding utf8 (Join-Path $work 'global.json') '{ "sdk": { "version": "10.0.100", "rollForward": "latestFeature" } }'
    Get-ChildItem (Join-Path $work 'src') -Recurse -Filter packages.lock.json | Remove-Item
    if (Test-Path $out) { Remove-Item -Recurse -Force $out }
    dotnet publish (Join-Path $work 'src\Passenger.DebugAdapter\Passenger.DebugAdapter.csproj') -c Release -r $Runtime --self-contained false -o $out
    if ($LASTEXITCODE) { throw "dotnet publish failed" }
    # Passenger's MIT licence and its notices (SharpDbg, ICorDebugSharp, ILSpy, ClrDebug...) go with its debugger.
    Copy-Item (Join-Path $work 'LICENSE') (Join-Path $out 'LICENSE.Passenger.txt')
    Copy-Item (Join-Path $work 'THIRD_PARTY_NOTICES.md') (Join-Path $out 'THIRD_PARTY_NOTICES.Passenger.md')
    Write-Host "Debugger for .NET 10 ($Runtime) in $out"
}
finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
