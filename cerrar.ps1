$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'app/data/server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $serverProcessId = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serverProcessId" -ErrorAction SilentlyContinue
    $serverPath = Join-Path $PSScriptRoot 'app/server.py'
    if ($process -and $process.CommandLine.Contains($serverPath)) { Stop-Process -Id $serverProcessId }
    Remove-Item -LiteralPath $pidFile
}
Write-Output 'App cerrada. Las asistencias siguen guardadas.'
