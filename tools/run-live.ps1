# Starts the live-camera backend (AGA) on this machine and, if cloudflared is installed, a public tunnel to it.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File tools\run-live.ps1
# Python with torch: set STREETLENS_PYTHON, or it uses %USERPROFILE%\bali-streetlens\.venv (the vision machine's venv).
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$python = if ($env:STREETLENS_PYTHON) { $env:STREETLENS_PYTHON } else { Join-Path $env:USERPROFILE "bali-streetlens\.venv\Scripts\python.exe" }
if (-not (Test-Path $python)) { throw "Python not found at $python. Set STREETLENS_PYTHON to a python with torch, opencv, fastapi, uvicorn and scipy." }
$logs = Join-Path $env:LOCALAPPDATA "streetlens-live"
New-Item -ItemType Directory -Force $logs | Out-Null
$port = 8000

# Backend: only start one if nothing answers on the port yet.
$up = $false
try { $up = (Invoke-WebRequest "http://127.0.0.1:$port/api/live/cameras" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
if (-not $up) {
  Start-Process -FilePath $python -WorkingDirectory $repo -WindowStyle Hidden `
    -ArgumentList "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "$port" `
    -RedirectStandardOutput (Join-Path $logs "backend.out.log") -RedirectStandardError (Join-Path $logs "backend.err.log")
  Write-Host "Backend starting on http://127.0.0.1:$port (logs in $logs)"
} else { Write-Host "Backend already running on port $port" }

$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) { $local = Join-Path $env:USERPROFILE "bin\cloudflared.exe"; if (Test-Path $local) { $cf = Get-Command $local } }
if (-not $cf) {
  Write-Host ""
  Write-Host "cloudflared is not installed, so there is no public link yet."
  Write-Host "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and run this script again."
  exit 0
}

# Tunnel: Cloudflare prints the public address in its log; read it from there.
$tlog = Join-Path $logs "tunnel.err.log"
Remove-Item $tlog -ErrorAction SilentlyContinue
Start-Process -FilePath $cf.Source -WindowStyle Hidden -ArgumentList "tunnel", "--url", "http://127.0.0.1:$port" `
  -RedirectStandardError $tlog -RedirectStandardOutput (Join-Path $logs "tunnel.out.log")
$url = $null
for ($i = 0; $i -lt 40 -and -not $url; $i++) {
  Start-Sleep 1
  if (Test-Path $tlog) { $m = Select-String -Path $tlog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
}
if (-not $url) { throw "No tunnel address found in $tlog" }
$share = "https://bali-streetlens.vercel.app/langsung?api=$url"
Set-Content -Path (Join-Path $logs "share-link.txt") -Value $share
Write-Host ""
Write-Host "Public link (open it once in each browser; it is remembered there):"
Write-Host $share
