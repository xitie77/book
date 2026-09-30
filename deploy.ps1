# Night Read - one-click deploy for Windows / PowerShell
# Usage:
#   .\deploy.ps1                build and run (listens on 127.0.0.1:8080)
#   .\deploy.ps1 -Port 9000     custom port
#   .\deploy.ps1 -Public        allow external access
#   .\deploy.ps1 -Logs          follow logs
#   .\deploy.ps1 -Down          stop and remove container (data kept)
# NOTE: this script is intentionally ASCII-only (Windows PowerShell 5.1 reads
#       .ps1 as GBK, non-ASCII would be mangled).
param(
  [int]$Port = 8080,
  [switch]$Public,
  [switch]$Logs,
  [switch]$Down
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$Image = "book:latest"
$Name = "book"
$DataVol = "book-data"

function Need-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "[X] docker not found. Install Docker Desktop first." -ForegroundColor Red
    exit 1
  }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Docker daemon is not running. Start Docker Desktop first." -ForegroundColor Red
    exit 1
  }
}

if ($Down) {
  docker rm -f $Name *> $null
  Write-Host "[OK] stopped (volume $DataVol kept)" -ForegroundColor Green
  exit 0
}
if ($Logs) { docker logs -f --tail 200 $Name; exit 0 }

Need-Docker

$bind = if ($Public) { "0.0.0.0" } else { "127.0.0.1" }

# --- 从 .env 读取配置（若存在）---
$AdminUser = "wbx"
$MaxUpload = "50"
$AdminPass = $env:ADMIN_PASSWORD
if (Test-Path ".env") {
  foreach ($line in Get-Content ".env") {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k, $v = $line.Split('=', 2)
    $k = $k.Trim(); $v = $v.Trim()
    if ($k -eq 'ADMIN_USERNAME' -and $v) { $AdminUser = $v }
    elseif ($k -eq 'MAX_UPLOAD_MB' -and $v) { $MaxUpload = $v }
    elseif ($k -eq 'ADMIN_PASSWORD' -and $v -and -not $AdminPass) { $AdminPass = $v }
  }
}
if (-not $AdminPass) {
  Write-Host "[X] ADMIN_PASSWORD is not set. Do one of:" -ForegroundColor Red
  Write-Host "    1) copy .env.example to .env and set ADMIN_PASSWORD"
  Write-Host "    2) set env var:  `$env:ADMIN_PASSWORD='yourpass'; .\deploy.ps1"
  exit 1
}

Write-Host "==> Building image $Image"
docker build -t $Image .
if ($LASTEXITCODE -ne 0) { Write-Host "[X] build failed" -ForegroundColor Red; exit 1 }

docker volume inspect $DataVol *> $null
if ($LASTEXITCODE -ne 0) { docker volume create $DataVol | Out-Null }

Write-Host "==> Starting container (${bind}:${Port} -> 4000)"
docker rm -f $Name *> $null
docker run -d `
  --name $Name `
  --restart unless-stopped `
  -p "${bind}:${Port}:4000" `
  -e PORT=4000 `
  -e MAX_UPLOAD_MB=$MaxUpload `
  -e ADMIN_USERNAME=$AdminUser `
  -e ADMIN_PASSWORD=$AdminPass `
  -v "${DataVol}:/app/server/data" `
  $Image | Out-Null

Write-Host -NoNewline "==> Waiting for health check"
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 *> $null
    Write-Host " OK"
    Write-Host ""
    Write-Host "[OK] Deployed: http://127.0.0.1:$Port (login $AdminUser)" -ForegroundColor Green
    exit 0
  } catch {
    Write-Host -NoNewline "."
    Start-Sleep -Seconds 1
  }
}
Write-Host " timeout. Last logs:"
docker logs --tail 50 $Name
exit 1
