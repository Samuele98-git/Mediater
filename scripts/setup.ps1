# ==============================================================
# Mediater — one-shot setup script (Windows PowerShell)
# ==============================================================
# Creates .env, installs deps, generates Prisma client, runs migrations.
$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")
$Root = (Get-Location).Path
Write-Host "==> Mediater setup ($Root)"

# 1) Node sanity check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node is not installed. Get Node 18+ from https://nodejs.org/"
    exit 1
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($nodeMajor -lt 18) {
    $v = node -v
    Write-Error "Node 18 or newer is required (you have $v)."
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

# 4) Dependencies
if (-not (Test-Path "node_modules")) {
    Write-Host "==> Installing dependencies"
    npm install
} else {
    Write-Host "==> Dependencies already installed (skip)"
}

# 5) Prisma
Write-Host "==> Generating Prisma client"
npx prisma generate
Write-Host "==> Applying database schema"
npx prisma db push

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "   Start in dev:        npm run dev"
Write-Host "   Start in production: `$env:NODE_ENV='production'; node server.js"
Write-Host "   Run with Docker:     docker compose up -d"
Write-Host ""
