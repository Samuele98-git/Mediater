#!/usr/bin/env sh
# ==============================================================
# Mediater — production launcher (Linux / macOS)
# ==============================================================
# Usage:  ./scripts/start.sh
#   - Runs setup if needed (deps + DB)
#   - Forces NODE_ENV=production
#   - Starts under PM2 if available, otherwise plain node
set -eu

cd "$(dirname "$0")/.."

# Setup if needed (deps, env, schema)
if [ ! -d node_modules ] || [ ! -f .env ]; then
    sh scripts/setup.sh
fi

export NODE_ENV=production

if command -v pm2 >/dev/null 2>&1; then
    echo "==> Starting Mediater via PM2"
    pm2 start ecosystem.config.cjs --env production --update-env
    pm2 save || true
    echo ""
    echo "   pm2 logs mediater     # tail logs"
    echo "   pm2 restart mediater  # restart"
    echo "   pm2 stop mediater     # stop"
else
    echo "==> PM2 not installed — running in foreground"
    echo "    (install PM2 globally with: npm i -g pm2)"
    exec node server.js
fi
