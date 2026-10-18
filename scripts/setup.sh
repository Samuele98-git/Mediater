#!/usr/bin/env sh
# ==============================================================
# Mediater — one-shot setup script (Linux / macOS / WSL)
# ==============================================================
# Creates .env, installs/updates deps, applies the database schema.
# Safe to run again after every update (git pull).
set -eu

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> Mediater setup ($ROOT)"

# 1) Node + npm sanity check
if ! command -v node >/dev/null 2>&1; then
    echo "[ERR] node is not installed. Get Node 22+ from https://nodejs.org/" >&2
    exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "[ERR] Node 22 or newer is required (you have $(node -v))." >&2
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

# 4) Dependencies (always: picks up new ones after an update)
echo "==> Installing dependencies"
npm install --no-audit --no-fund

# 5) Database
echo "==> Applying database schema"
node scripts/migrate.mjs

# 6) ffmpeg (optional but strongly recommended)
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    echo "==> ffmpeg found: $(ffmpeg -version | head -n 1)"
else
    echo ""
    echo "[!] ffmpeg was not found. Mediater works without it, but only MP4/WebM files"
    echo "    will play. Install it to play MKV/AVI/HEVC/AC3 and get thumbnails:"
    echo "      Debian/Ubuntu:  sudo apt install ffmpeg"
    echo "      macOS:          brew install ffmpeg"
fi

echo ""
echo "✅ Setup complete."
echo ""
echo "   Start in dev:        npm run dev"
echo "   Start in production: ./scripts/start.sh"
echo "   Run with Docker:     make docker-up"
echo ""
