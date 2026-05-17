# ==============================================================
# Mediater — multi-stage production image
# ==============================================================

# ---------- 1. Builder ----------
FROM node:20-slim AS builder
WORKDIR /app

# Install OS deps Prisma needs at build/run time
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx prisma generate

# Copy the rest of the source after deps are cached
COPY . .

# ---------- 2. Runtime ----------
FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    UPLOAD_DIR=/data/uploads \
    SESSION_DIR=/data/sessions \
    DATABASE_URL=file:/data/mediater.db

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Copy app + node_modules from builder
COPY --from=builder /app /app

# Persist data outside the image
RUN mkdir -p /data/uploads/images /data/uploads/videos /data/sessions \
 && chown -R node:node /data /app

USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# tini = small init for clean PID 1 / proper signal forwarding
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
