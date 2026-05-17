#!/usr/bin/env sh
# ==============================================================
# Mediater — one-shot setup script (Linux / macOS / WSL)
# ==============================================================
# Creates .env, installs deps, generates Prisma client, runs migrations.
set -eu

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> Mediater setup ($ROOT)"

# 1) Node + npm sanity check
if ! command -v node >/dev/null 2>&1; then
    echo "[ERR] node is not installed. Get Node 18+ from https://nodejs.org/" >&2
    exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "[ERR] Node 18 or newer is required (you have $(node -v))." >&2
    exit 1
fi

# 2) .env bootstrap
if [ ! -f .env ]; then
    echo "==> Creating .env from .env.example"
    cp .env.example .env
fi

# 3) Generate SESSION_SECRET if blank
if grep -qE '^SESSION_SECRET=\s*$' .env; then
    SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
    # portable in-place edit (BSD vs GNU sed)
    if sed --version >/dev/null 2>&1; then
        sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
    else
        sed -i '' "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
    fi
    echo "==> Generated SESSION_SECRET in .env"
fi

# 4) Dependencies
if [ ! -d node_modules ]; then
    echo "==> Installing dependencies"
    npm install
else
    echo "==> Dependencies already installed (skip)"
fi

# 5) Prisma
echo "==> Generating Prisma client"
npx prisma generate
echo "==> Applying database schema"
npx prisma db push

echo ""
echo "✅ Setup complete."
echo ""
echo "   Start in dev:        npm run dev"
echo "   Start in production: NODE_ENV=production node server.js"
echo "   Run with PM2:        make pm2-start"
echo "   Run with Docker:     make docker-up"
echo ""
