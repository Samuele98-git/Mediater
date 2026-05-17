# Mediater 🍿

**Mediater** is a self-hosted, Netflix-style media streaming server with a sleek viewer interface and a full Admin Dashboard for managing content, users, and settings without touching code.

![Mediater](/imgxtx/mediater.png)

## 📑 Table of Contents

- [Features](#-features)
- [Prerequisites](#-prerequisites)
- [Quick start](#-quick-start)
- [Makefile shortcuts](#-makefile-shortcuts)
- [Environment variables](#-environment-variables-env)
- [Server deployment](#-server-deployment)
- [Safety checklist](#-safety-checklist-before-going-public)
- [Player keyboard shortcuts](#-player-keyboard-shortcuts)
- [HTTP endpoints](#-http-endpoints)
- [Configuration & Customization](#-configuration--customization)
- [Project structure](#-project-structure)
- [Troubleshooting](#-troubleshooting)

---

## ✨ Features

* **Netflix-style interface** — auto-rotating hero, hover previews, detail modal, horizontal rows, custom video player with resume/skip/PiP/keyboard shortcuts.
* **Continue Watching + My List** — per-user progress tracking and favorites.
* **Range-based video streaming** — instant seeking even on huge files.
* **Admin Dashboard** — full GUI management of Movies, Series, Episodes, Users, and Branding.
* **Drag & Drop Upload** for covers, backdrops, logos, and video files.
* **SSO Support** — native OpenID Connect (Authentik / Keycloak).
* **Hardened defaults** — bcrypt-hashed passwords, signed sessions, opt-in HTTPS cookies, trust-proxy support, security headers.
* **Multiple deploy paths** — plain Node, PM2, Docker / Docker Compose.

---

## 🚀 Prerequisites

* **Node.js 18+** — [Download](https://nodejs.org/)  *(or use Docker — see below)*
* **Git** — [Download](https://git-scm.com/)

---

## ⚡ Quick start

```bash
git clone https://github.com/Samuele98-git/Mediater.git
cd Mediater
```

Then pick **one** of the three options below.

### Option A — One-shot script (recommended)

```bash
# Linux / macOS / WSL
./scripts/setup.sh   # installs deps, creates .env, generates SESSION_SECRET, runs migrations
npm run dev          # development with auto-reload
# or
./scripts/start.sh   # production — uses PM2 if installed, otherwise foreground
```

```powershell
# Windows
.\scripts\setup.ps1
npm run dev
# or
.\scripts\start.ps1
```

### Option B — Docker (no Node required)

```bash
cp .env.example .env                 # then edit .env
docker compose build
docker compose up -d
docker compose logs -f               # tail logs
```

All persistent data (DB, uploads, sessions) lives in the named volume `mediater_data` — survives `docker compose down`.

### Option C — Manual

```bash
cp .env.example .env                 # generate a SESSION_SECRET in here
npm install
npx prisma db push
npm start                            # production
# or
npm run dev                          # development
```

Open **http://localhost:3000** and sign in with the admin credentials from your `.env` (default: `admin / admin123` — **change immediately**).

---

## 🛠 Makefile shortcuts

```bash
make help            # list every target
make setup           # first-time setup
make dev             # development mode
make start           # production mode (foreground)
make migrate         # prisma db push
make pm2-start       # run under PM2
make docker-up       # start Docker stack
make docker-logs     # tail container logs
make backup          # snapshot uploads + DB + sessions into ./backups/
```

---

## 🔐 Environment variables (`.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | Set to `production` to enable tighter defaults |
| `PORT` | no | `3000` | HTTP port |
| `HOST` | no | `127.0.0.1` (dev) / `0.0.0.0` (prod) | Bind address |
| `SESSION_SECRET` | **yes in prod** | _(random in dev)_ | Long random string. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SESSION_TTL_DAYS` | no | `30` | Session lifetime |
| `COOKIE_SECURE` | no | `false` | Set `true` when serving over HTTPS |
| `TRUST_PROXY` | no | `1` in prod | Trust this many proxy hops (Nginx, Cloudflare, etc.) |
| `ADMIN_USERNAME` | no | `admin` | Bootstrap admin username |
| `ADMIN_PASSWORD` | no | `admin123` | Bootstrap admin password — **change it** |
| `DATABASE_URL` | no | `file:./dev.db` | Prisma SQLite path |
| `UPLOAD_DIR` | no | `./public/uploads` | Override for Docker volumes |
| `SESSION_DIR` | no | `./sessions` | Override for Docker volumes |

In **production**, if `SESSION_SECRET` is missing the server **refuses to start**.

---

## 🌐 Server deployment

### 1) With Docker Compose behind Nginx

```bash
git clone https://github.com/Samuele98-git/Mediater.git /opt/mediater
cd /opt/mediater
cp .env.example .env
# Edit .env — set SESSION_SECRET, ADMIN_PASSWORD, COOKIE_SECURE=true
docker compose up -d
```

Then put Nginx in front (any web server works; example below):

```nginx
server {
    listen 80;
    server_name media.example.com;
    client_max_body_size 10000M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

Enable HTTPS with `certbot --nginx -d media.example.com`, then set `COOKIE_SECURE=true` in `.env` and restart.

### 2) With PM2 (no Docker)

```bash
sudo npm install -g pm2
cd /opt/mediater
./scripts/setup.sh
pm2 start ecosystem.config.cjs --env production
pm2 startup           # follow the printed instructions
pm2 save
```

`pm2 logs mediater`, `pm2 restart mediater`, `pm2 stop mediater`.

### 3) systemd (no PM2, no Docker)

```ini
# /etc/systemd/system/mediater.service
[Unit]
Description=Mediater
After=network.target

[Service]
Type=simple
User=mediater
WorkingDirectory=/opt/mediater
EnvironmentFile=/opt/mediater/.env
ExecStart=/usr/bin/node /opt/mediater/server.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mediater
sudo journalctl -u mediater -f
```

---

## 🧰 Safety checklist before going public

- [ ] `SESSION_SECRET` set to a long random string.
- [ ] `ADMIN_PASSWORD` changed from the default.
- [ ] `NODE_ENV=production`.
- [ ] HTTPS terminated by a reverse proxy, with `COOKIE_SECURE=true` and `TRUST_PROXY=1`.
- [ ] `client_max_body_size` raised in your reverse proxy if you upload large videos.
- [ ] Volumes / paths under `public/uploads`, `sessions/`, and the DB file backed up.
- [ ] `/healthz` reachable from your orchestrator / uptime monitor.

> 💡 The Docker image runs the app as the unprivileged `node` user, drops all kernel capabilities, applies `no-new-privileges`, and persists data in the named volume `mediater_data`.

---

## ⌨️ Player keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `J` / `←` | Back 5–10 s |
| `L` / `→` | Forward 5–10 s |
| `↑` / `↓` | Volume up / down |
| `M` | Mute |
| `F` | Fullscreen |
| `Esc` | Exit search / close modal |

The player also supports Picture-in-Picture, drag-seek on the progress bar, auto-resume from the last position, and auto-play of the next episode for series.

---

## 🔌 HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/` | Browse (home, requires auth) |
| `GET`  | `/movies` / `/series` / `/mylist` / `/search?q=` | Filtered browse |
| `GET`  | `/watch/:id` | Player or series detail page |
| `GET`  | `/stream/:id` | Range-aware video stream (206 Partial Content) |
| `POST` | `/api/progress` | Save resume position (`{mediaId, position, duration}`) |
| `POST` | `/api/mylist/:id` | Toggle a title in My List |
| `GET`  | `/api/details/:id` | JSON payload for the detail modal |
| `GET`  | `/healthz` | Liveness probe (`{"ok":true,"env":"production"}`) |
| `GET`  | `/login` / `POST /auth/local` | Sign-in |
| `GET`  | `/auth/sso` / `/auth/callback` | OIDC (when configured) |
| `GET`  | `/logout` | Sign out and clear cookie |
| `/admin/*` | (admin only) | Library, users, settings management |

---

## ⚙️ Configuration & Customization

### Branding
1. Log in as Admin → **Manage** → **Settings**.
2. Set **App Name** and **Accent Color**.

### Authentik / Keycloak (SSO)
1. **Manage** → **Settings** → fill OIDC fields.
2. Log out — the login page now shows the SSO button.

---

## 📂 Project Structure

```
server.js                — entry point (env-driven, hardened)
routes/                  — auth, admin, profile, views
views/                   — EJS templates (Netflix-style)
public/                  — static assets + uploads (volume in Docker)
prisma/schema.prisma     — DB schema
scripts/                 — setup.sh/ps1, start.sh/ps1
Dockerfile               — multi-stage non-root image
docker-compose.yml       — single-service stack with named volume
ecosystem.config.cjs     — PM2 config
Makefile                 — convenience targets
.env.example             — copy to .env and fill in
```

---

## 🛠 Troubleshooting

**`SESSION_SECRET` error on startup** — set it in `.env` (production refuses to start without one).

**File too large during upload** — internal limit is 5 GB; if behind Nginx, raise `client_max_body_size`.

**Database errors after a schema change** — `npx prisma db push`, or `make migrate`.

**Want to wipe everything and start fresh** — `make reset` (asks for confirmation).

**Backup from Docker** — `docker compose exec mediater sh -c "tar czf - /data" > backup.tar.gz` snapshots the entire data volume (DB + uploads + sessions).

**Existing admin can't log in after upgrading from 1.x** — old installs stored the admin password in plaintext; the new code only accepts bcrypt hashes. Re-hash it once with:
```bash
node -e "require('bcryptjs').hash('YOUR-NEW-PASSWORD',10).then(h=>require('@prisma/client').PrismaClient&&new(require('@prisma/client').PrismaClient)().user.update({where:{username:'admin'},data:{password:h}}).then(()=>console.log('done')))"
```

