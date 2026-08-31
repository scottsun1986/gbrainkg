#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for command_name in docker openssl curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required. Install Docker Engine and the host prerequisites first." >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi

ENV_FILE="$ROOT_DIR/.env"
SECRET_DIR="$ROOT_DIR/.secrets"
SECRET_FILE="$SECRET_DIR/admin_initial_password"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml)

if [[ ! -f "$ENV_FILE" ]]; then
  cp deploy/production.env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  random_secret() { openssl rand -hex 32; }
  sed -i \
    -e "s#replace-with-a-long-random-database-password#$(random_secret)#" \
    -e "s#replace-with-a-long-random-redis-password#$(random_secret)#" \
    -e "s#replace-with-a-long-random-minio-password#$(random_secret)#" \
    -e "s#replace-with-a-long-random-auth-secret#$(random_secret)#" \
    -e "s#replace-with-a-different-long-random-model-config-key#$(random_secret)#" \
    -e "s#replace-with-a-long-random-parser-token#$(random_secret)#" \
    "$ENV_FILE"
  echo "Created $ENV_FILE with generated service secrets."
fi

ensure_http_port() {
  local configured_port
  configured_port="$(awk -F= '$1 == "HTTP_PORT" {print $2}' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]')"
  if [[ -z "$configured_port" ]]; then
    echo 'HTTP_PORT=20080' >> "$ENV_FILE"
    configured_port=20080
  elif [[ "$configured_port" == '80' || "$configured_port" == '8080' || "$configured_port" == '443' || "$configured_port" == '8443' ]]; then
    sed -i "s/^HTTP_PORT=.*/HTTP_PORT=20080/" "$ENV_FILE"
    configured_port=20080
    echo "Migrated the legacy HTTP_PORT to $configured_port."
  fi
  if ! [[ "$configured_port" =~ ^[0-9]+$ ]] || (( configured_port < 20000 || configured_port > 65535 )); then
    echo "HTTP_PORT must be between 20000 and 65535; got '$configured_port'." >&2
    exit 1
  fi
}

ensure_http_port

mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"
if [[ ! -s "$SECRET_FILE" ]]; then
  if [[ -n "${ADMIN_INITIAL_PASSWORD:-}" ]]; then
    printf '%s\n' "$ADMIN_INITIAL_PASSWORD" > "$SECRET_FILE"
    unset ADMIN_INITIAL_PASSWORD
  elif [[ -t 0 ]]; then
    while true; do
      read -r -s -p "Set initial password for admin (minimum 12 characters): " admin_password
      echo
      read -r -s -p "Confirm initial password: " admin_password_confirm
      echo
      [[ "$admin_password" == "$admin_password_confirm" && ${#admin_password} -ge 12 ]] && break
      echo "Passwords must match and contain at least 12 characters."
    done
    printf '%s\n' "$admin_password" > "$SECRET_FILE"
    unset admin_password admin_password_confirm
  else
    echo "Set ADMIN_INITIAL_PASSWORD in a protected environment for unattended install." >&2
    exit 1
  fi
  chmod 600 "$SECRET_FILE"
fi

echo "Building production images..."
"${COMPOSE[@]}" build api-image parser web

echo "Starting database, cache and parser..."
"${COMPOSE[@]}" up -d postgres redis minio parser
"${COMPOSE[@]}" up --wait postgres redis minio parser

echo "Running Prisma migrations and production bootstrap..."
"${COMPOSE[@]}" rm -sf bootstrap >/dev/null 2>&1 || true
"${COMPOSE[@]}" up --no-deps bootstrap

echo "Starting API, Web and reverse proxy..."
"${COMPOSE[@]}" up -d api web nginx
"${COMPOSE[@]}" up --wait api web nginx

deploy/healthcheck.sh
echo
echo "Installation complete. Login username: admin"
echo "The first login must use the configured initial password and then set a new password."
echo "No demo users, organizations, knowledge bases or documents were created."
