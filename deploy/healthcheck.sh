#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-3202}"
WEB_PORT="${WEB_PORT:-3200}"
PARSER_PORT="${PARSER_PORT:-8100}"

echo "=================================================="
echo "          LLMWiki Production Healthcheck          "
echo "=================================================="

# 1. Check Systemd User Services
echo "[1/4] Checking Systemd User Services..."
SERVICES=("llmwiki-parser.service" "llmwiki-api.service" "llmwiki-web.service")
ALL_SERVICES_OK=true

for svc in "${SERVICES[@]}"; do
  if systemctl --user is-active --quiet "$svc"; then
    echo "  ✔ $svc is active (running)"
  else
    echo "  ✘ $svc is NOT active ($(systemctl --user is-active "$svc" 2>/dev/null || echo "unknown"))"
    ALL_SERVICES_OK=false
  fi
done

if [[ "$ALL_SERVICES_OK" != "true" ]]; then
  echo "Error: One or more services failed to run." >&2
  exit 1
fi

# 2. Check Parser Worker HTTP Endpoint
echo "[2/4] Checking Parser Worker (port $PARSER_PORT)..."
PARSER_STATUS="$(curl -ksS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PARSER_PORT}/health" 2>/dev/null || echo "000")"
if [[ "$PARSER_STATUS" == "200" ]]; then
  echo "  ✔ Parser Worker /health returned HTTP 200"
else
  echo "  ✘ Parser Worker /health failed: HTTP $PARSER_STATUS" >&2
  exit 1
fi

# 3. Check API Backend HTTP Endpoint
echo "[3/4] Checking API Backend (port $API_PORT)..."
API_STATUS="$(curl -ksS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || echo "000")"
if [[ "$API_STATUS" == "200" ]]; then
  echo "  ✔ API Backend /health returned HTTP 200"
else
  echo "  ✘ API Backend /health failed: HTTP $API_STATUS" >&2
  exit 1
fi

# 4. Check Web Frontend HTTP Endpoint
echo "[4/4] Checking Web Frontend (port $WEB_PORT)..."
WEB_STATUS="$(curl -ksS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null || echo "000")"
if [[ "$WEB_STATUS" == "200" || "$WEB_STATUS" == "304" ]]; then
  echo "  ✔ Web Frontend / returned HTTP $WEB_STATUS"
else
  echo "  ✘ Web Frontend / failed: HTTP $WEB_STATUS" >&2
  exit 1
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"
echo "=================================================="
echo "✔ All LLMWiki services are healthy and operational!"
echo "  - Web UI:      http://${HOST_IP}:${WEB_PORT} (http://127.0.0.1:${WEB_PORT})"
echo "  - API Backend: http://${HOST_IP}:${API_PORT} (http://127.0.0.1:${API_PORT})"
echo "  - Parser:      http://127.0.0.1:${PARSER_PORT}"
echo "=================================================="
