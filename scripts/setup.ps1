# ==============================================================
# Mediater — one-shot setup script (Windows PowerShell)
# ==============================================================
# Creates .env, installs/updates deps, applies the database schema.
# Safe to run again after every update (git pull).
$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")
$Root = (Get-Location).Path
Write-Host "==> Mediater setup ($Root)"

# 1) Node sanity check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node is not installed. Get Node 22+ from https://nodejs.org/ (or: winget install OpenJS.NodeJS.LTS)"
    exit 1
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($nodeMajor -lt 22) {
    $v = node -v
    Write-Error "Node 22 or newer is required (you have $v)."
    exit 1
}

# 2) .env bootstrap
if (-not (Test-Path ".env")) {
    Write-Host "==> Creating .env from .env.example"
    Copy-Item ".env.example" ".env"
}

# 3) Generate SESSION_SECRET if blank
$envText = Get-Content ".env" -Raw
if ($envText -match '(?m)^SESSION_SECRET=\s*$') {
    $secret = node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
    $envText = $envText -replace '(?m)^SESSION_SECRET=.*$', "SESSION_SECRET=$secret"
    Set-Content -Path ".env" -Value $envText -Encoding utf8 -NoNewline
    Write-Host "==> Generated SESSION_SECRET in .env"
}

# 4) Dependencies (always: picks up new ones after an update)
Write-Host "==> Installing dependencies"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }

# 5) Database
Write-Host "==> Applying database schema"
node scripts/migrate.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "Database setup failed"; exit 1 }

# 6) ffmpeg (optional but strongly recommended)
if ((Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    Write-Host "==> ffmpeg found"
} else {
    Write-Host ""
    Write-Host "[!] ffmpeg was not found. Mediater works without it, but only MP4/WebM files" -ForegroundColor Yellow
    Write-Host "    will play. Install it to play MKV/AVI/HEVC/AC3 and get thumbnails:" -ForegroundColor Yellow
    Write-Host "      winget install Gyan.FFmpeg      (then open a new terminal)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "   Start in dev:        npm run dev"
Write-Host "   Start in production: .\scripts\start.ps1"
Write-Host "   Run with Docker:     docker compose up -d"
Write-Host ""
