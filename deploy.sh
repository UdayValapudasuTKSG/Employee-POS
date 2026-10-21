#!/bin/bash
# One-run deploy onto a VM, safe on a database that already holds data.
#
#   ./deploy.sh
#
# Follows deploy/README.md: back up, run every migration (idempotent), never
# load schema.sql over an existing database, build, then install the API
# service and the portal. Re-running it is safe.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$APP_DIR/artifacts/bhi-card-portal/dist/public"
API_ENTRY="$APP_DIR/artifacts/api-server/dist/index.mjs"
NGINX_ROOT="/var/www/bhi"   # must match "root" in deploy/nginx-bhi.conf
BACKUP_DIR="$HOME/bhi-backups"
RUN_USER="$(id -un)"

echo "======================================="
echo " BHI Portal Deployment"
echo "======================================="
cd "$APP_DIR"

echo "[1/10] Checking .env..."
if [ ! -f .env ]; then
  echo "❌ .env missing. Copy artifacts/api-server/.env.example to .env and fill it in first."
  exit 1
fi
env_get() { { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; } || true; }
DB_URL="$(env_get DATABASE_URL)"
PORT="$(env_get PORT)"; PORT="${PORT:-3001}"
for v in DATABASE_URL SESSION_SECRET; do
  [ -n "$(env_get "$v")" ] || { echo "❌ $v is not set in .env"; exit 1; }
done
[ "$(env_get NODE_ENV)" = "production" ] || echo "⚠️  NODE_ENV is not 'production' in .env."
[ "$(env_get DEMO_SEED)" = "false" ] || echo "⚠️  DEMO_SEED is not 'false': the API will add the TEST VALUES demo rate card (and demo data on an empty database)."
[ "$(env_get OTP_DEV_MODE)" != "true" ] || echo "⚠️  OTP_DEV_MODE=true: verification codes are not really sent."
[ "$(env_get HOST)" != "0.0.0.0" ] || echo "⚠️  HOST=0.0.0.0 exposes the API port directly; use HOST=127.0.0.1 behind nginx."
# Parse the URL for createdb: postgresql://user:pass@host:port/db?params
DB_NAME="$(echo "$DB_URL" | sed -E 's#^[^/]*//[^/]*/([^?]*).*#\1#')"
DB_USER="$(echo "$DB_URL" | sed -E 's#^[^/]*//([^:@]*).*#\1#')"

echo "[2/10] Installing dependencies..."
pnpm install --frozen-lockfile

echo "[3/10] Checking the database..."
NEW_DB=0
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\";"
  NEW_DB=1
fi
# The API runs as bhi_app; creating it needs the superuser (README step 1).
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bhi_app') THEN
    CREATE ROLE bhi_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;
GRANT bhi_app TO "${DB_USER}";
SQL

if [ "$NEW_DB" = 1 ]; then
  echo "[4/10] New database: loading schema..."
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f deploy/db/schema.sql
else
  echo "[4/10] Existing database: backing up before migrating..."
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/${DB_NAME}-$(date +%Y%m%d-%H%M%S).dump"
  # Row-level security hides rows from bhi_user too; bhi.all=on reads every company.
  PGOPTIONS="-c bhi.all=on" pg_dump --enable-row-security --format=custom --file="$BACKUP" "$DB_URL"
  echo "    Backup: $BACKUP  (restore: pg_restore --clean -d \"\$DATABASE_URL\" \"$BACKUP\")"
fi

echo "[5/10] Running migrations..."
for f in deploy/db/migrations/*.sql; do
  echo "    $f"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "[6/10] Building application..."
pnpm build
[ -f "$API_ENTRY" ] || { echo "❌ API build not found: $API_ENTRY"; exit 1; }
[ -f "$FRONTEND_DIR/index.html" ] || { echo "❌ Frontend build not found: $FRONTEND_DIR"; exit 1; }

echo "[7/10] Installing & starting backend service..."
sed -e "s#^User=.*#User=${RUN_USER}#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=${APP_DIR}/.env#" \
    -e "s#^ExecStart=.*#ExecStart=$(command -v node) --enable-source-maps ${API_ENTRY}#" \
    deploy/bhi-api.service | sudo tee /etc/systemd/system/bhi-api.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable bhi-api
sudo systemctl restart bhi-api

echo "[8/10] Checking backend..."
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/readyz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then
  echo "✅ Backend up on ${PORT} and reaching the database."
else
  echo "❌ Backend not ready (/api/readyz)."
  curl -sS "http://127.0.0.1:${PORT}/api/readyz" || true
  sudo journalctl -u bhi-api -n 50 --no-pager
  exit 1
fi

echo "[9/10] Deploying frontend + nginx config..."
sudo mkdir -p "$NGINX_ROOT"
sudo rm -rf "${NGINX_ROOT:?}"/*
sudo cp -r "$FRONTEND_DIR"/. "$NGINX_ROOT"/
sudo cp deploy/nginx-bhi.conf /etc/nginx/sites-available/bhi
sudo ln -sf /etc/nginx/sites-available/bhi /etc/nginx/sites-enabled/bhi

echo "[10/10] Restarting Nginx..."
sudo nginx -t
sudo systemctl restart nginx

echo
echo "======================================="
echo " Deployment Complete"
echo "======================================="
echo "Status : sudo systemctl status bhi-api"
echo "Logs   : sudo journalctl -u bhi-api -f"
