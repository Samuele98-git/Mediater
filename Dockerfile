# ==============================================================
# Mediater — multi-stage production image
# ==============================================================

# ---------- 1. Builder ----------
FROM node:22-slim AS builder
WORKDIR /app

# openssl: Prisma. python3/make/g++: fallback for native modules without prebuilds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
# Install scripts must run: the torrent client's WebRTC module downloads a native binary.
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx prisma generate

# Copy the rest of the source after deps are cached
COPY . .

# ---------- 2. Runtime ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads \
    DATABASE_URL=file:/data/mediater.db \
    TORRENT_PORT=6881 \
    TORRENT_UPNP=false

WORKDIR /app

# ffmpeg: plays MKV/AVI/HEVC/AC3/DTS files in any browser, thumbnails, subtitles.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates curl tini ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

# Persist data outside the image
RUN mkdir -p /data/uploads/images /data/uploads/videos /data/downloads /data/cache \
 && chown -R node:node /data /app

USER node
EXPOSE 3000 6881 6881/udp
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# tini = small init for clean PID 1 / proper signal forwarding
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
