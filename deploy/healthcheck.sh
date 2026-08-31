#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml)
echo "Checking container health..."
"${COMPOSE[@]}" ps

for endpoint in /health /api/v1/auth/me; do
  status="$(curl -ksS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT:-20080}${endpoint}")" || true
  if [[ "$endpoint" == "/health" && "$status" != "200" ]]; then
    echo "Health check failed: $endpoint returned HTTP $status" >&2
    exit 1
  fi
done

echo "LLMWiki is ready at http://$(hostname -I 2>/dev/null | awk '{print $1}'):${HTTP_PORT:-20080}"
