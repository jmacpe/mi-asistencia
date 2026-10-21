param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = Join-Path $PSScriptRoot 'app'
$appUrl = 'http://127.0.0.1:8765'
$running = $false
try {
    $existing = Invoke-RestMethod -Uri "$appUrl/api/state" -TimeoutSec 2
    $running = $existing.version -eq 1 -and $null -ne $existing.courses
} catch {}
if (-not $running) {
    $python = (Get-Command python -ErrorAction Stop).Source
    $dataDir = Join-Path $appRoot 'data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $serverPath = Join-Path $appRoot 'server.py'
    $process = Start-Process -FilePath $python -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log')
    $process.Id | Set-Content -LiteralPath (Join-Path $dataDir 'server.pid')
    for ($attempt = 0; $attempt -lt 35; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $status = Invoke-RestMethod -Uri "$appUrl/api/state" -TimeoutSec 2
            if ($status.version -eq 1) { $running = $true; break }
        } catch {}
        if ($process.HasExited) { break }
    }
    if (-not $running) { throw 'No se pudo iniciar la app. Revisá app/data/server-error.log o si el puerto 8765 está ocupado.' }
}
if (-not $NoBrowser) { Start-Process $appUrl }
Write-Output "Mi asistencia lista: $appUrl"
