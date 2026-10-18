# ==============================================================
# Mediater — convenience targets
# Run `make help` to list every command.
# ==============================================================

SHELL := /bin/sh
NPM   ?= npm
NODE  ?= node
DOCKER ?= docker
COMPOSE ?= docker compose

.DEFAULT_GOAL := help

.PHONY: help install setup dev start migrate reset-pin generate prisma-studio \
        pm2-start pm2-stop pm2-restart pm2-logs pm2-status \
        docker-build docker-up docker-down docker-logs docker-restart docker-shell \
        backup restore clean reset

help: ## Show this help
	@echo ""
	@echo "Mediater — available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ---------- Setup ----------
install: ## Install npm dependencies
	$(NPM) install

setup: ## First-time setup — copy .env, install deps, run migrations
	@./scripts/setup.sh

# ---------- Dev / Run ----------
dev: ## Start in development mode (auto-reload via nodemon)
	$(NPM) run dev

start: ## Start in production mode (foreground)
	NODE_ENV=production $(NPM) start

migrate: ## Apply Prisma schema to the database
	$(NODE) scripts/migrate.mjs

reset-pin: ## Remove the admin profile's PIN (if you forgot it)
	$(NODE) scripts/reset-pin.mjs

generate: ## Regenerate the Prisma client
	npx prisma generate

prisma-studio: ## Open Prisma Studio (DB inspector at :5555)
	npx prisma studio

# ---------- PM2 ----------
pm2-start: ## Start under PM2 (background, auto-restart)
	pm2 start ecosystem.config.cjs --env production

pm2-stop: ## Stop the PM2 process
	pm2 stop mediater

pm2-restart: ## Restart the PM2 process
	pm2 restart mediater

pm2-logs: ## Tail the PM2 logs
	pm2 logs mediater

pm2-status: ## Show PM2 status
	pm2 status

# ---------- Docker ----------
docker-build: ## Build the Docker image
	$(COMPOSE) build

docker-up: ## Start the stack (detached)
	$(COMPOSE) up -d

docker-down: ## Stop and remove the stack
	$(COMPOSE) down

docker-restart: ## Restart the container
	$(COMPOSE) restart

docker-logs: ## Tail container logs
	$(COMPOSE) logs -f --tail=100

docker-shell: ## Open a shell in the running container
	$(COMPOSE) exec mediater sh

# ---------- Maintenance ----------
backup: ## Snapshot the database, uploads and app data (not downloads) into ./backups/
	@mkdir -p backups
	@stamp=$$(date +%Y%m%d-%H%M%S); \
	 tar czf backups/mediater-$$stamp.tar.gz \
	  --exclude='./node_modules' --exclude='./backups' \
	  --exclude='./data/downloads' --exclude='./data/cache' \
	  ./public/uploads ./data ./prisma/dev.db ./prisma/dev.db-wal 2>/dev/null || true; \
	 echo "Backup written to backups/mediater-$$stamp.tar.gz"

clean: ## Remove node_modules + generated Prisma client
	rm -rf node_modules generated

reset: clean ## Full reset — delete data too (DESTRUCTIVE, asks first)
	@echo "This will delete: prisma/dev.db, data/ (including downloads), public/uploads/"
	@read -p "Type YES to confirm: " ans; [ "$$ans" = "YES" ] && rm -rf prisma/dev.db prisma/dev.db-wal prisma/dev.db-shm data public/uploads/images public/uploads/videos public/uploads/subtitles || echo "aborted"
