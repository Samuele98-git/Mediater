# ==============================================================
# Mediater — production launcher (Windows PowerShell)
# ==============================================================
# Usage:  .\scripts\start.ps1
#   - Runs setup if needed
#   - Forces NODE_ENV=production
#   - Starts under PM2 if available, otherwise plain node
$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "node_modules") -or -not (Test-Path ".env")) {
    & "$PSScriptRoot\setup.ps1"
}

$env:NODE_ENV = "production"

if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    Write-Host "==> Starting Mediater via PM2"
    pm2 start ecosystem.config.cjs --env production --update-env
    pm2 save
    Write-Host ""
    Write-Host "   pm2 logs mediater     # tail logs"
    Write-Host "   pm2 restart mediater  # restart"
    Write-Host "   pm2 stop mediater     # stop"
} else {
    Write-Host "==> PM2 not installed — running in foreground"
    Write-Host "    (install PM2 globally with: npm i -g pm2)"
    node server.js
}
