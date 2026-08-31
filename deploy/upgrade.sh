#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[[ -f .env ]] || { echo "Missing .env. Run deploy/install.sh first." >&2; exit 1; }

COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.prod.yml)

configured_port="$(awk -F= '$1 == "HTTP_PORT" {print $2}' .env | tail -n 1 | tr -d '[:space:]')"
if [[ "$configured_port" == '80' || "$configured_port" == '8080' || "$configured_port" == '443' || "$configured_port" == '8443' ]]; then
  sed -i "s/^HTTP_PORT=.*/HTTP_PORT=20080/" .env
  configured_port=20080
  echo "Migrated the legacy HTTP_PORT to $configured_port."
elif [[ -z "$configured_port" ]]; then
  echo 'HTTP_PORT=20080' >> .env
  configured_port=20080
fi
if ! [[ "$configured_port" =~ ^[0-9]+$ ]] || (( configured_port < 20000 || configured_port > 65535 )); then
  echo "HTTP_PORT must be between 20000 and 65535; got '$configured_port'." >&2
  exit 1
fi

"${COMPOSE[@]}" build api-image parser web
"${COMPOSE[@]}" up -d postgres redis minio parser
"${COMPOSE[@]}" up --wait postgres redis minio parser
"${COMPOSE[@]}" rm -sf bootstrap >/dev/null 2>&1 || true
"${COMPOSE[@]}" up --no-deps bootstrap
"${COMPOSE[@]}" up -d api web nginx
"${COMPOSE[@]}" up --wait api web nginx
deploy/healthcheck.sh
echo "Upgrade complete. Existing data and the admin password were preserved."
