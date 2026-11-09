# Builds CSharpShooter.SqlCheck (sqlcheck/: the syntax check behind csharpShooter.sql.checkQuery) into sqltools/, next to
# the SQL Tools Service's SqlParser it calls; run after fetch-sqltools. Only its own assembly and runtimeconfig are kept,
# and no .deps.json, so the host finds SqlParser in the folder.
#   powershell -File scripts/build-sqlcheck.ps1
$ErrorActionPreference = 'Stop'
$sql = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $sql 'sqltools'
if (-not (Test-Path (Join-Path $tools 'Microsoft.SqlServer.Management.SqlParser.dll'))) { throw "Run npm run fetch-sqltools first." }
$out = Join-Path $sql 'sqlcheck\out'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet build (Join-Path $sql 'sqlcheck\CSharpShooter.SqlCheck.csproj') -c Release -o $out
if ($LASTEXITCODE) { throw "dotnet build failed" }
foreach ($name in 'CSharpShooter.SqlCheck.dll', 'CSharpShooter.SqlCheck.runtimeconfig.json') { Copy-Item (Join-Path $out $name) $tools -Force }
Remove-Item -Recurse -Force $out
Write-Host "SqlCheck in $tools"
