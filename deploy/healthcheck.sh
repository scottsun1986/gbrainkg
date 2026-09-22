#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# API port default is 3000 (base); Web is 3200. Port formula:
# API = 3000 + 2*(N-1), Web = 3200 + 2*(N-1) for instance N.
API_PORT="${API_PORT:-3202}"
WEB_PORT="${WEB_PORT:-3200}"
PARSER_PORT="${PARSER_PORT:-8100}"

# Auto-detect: test/legacy installs use systemd --user (deploy/install.sh);
# production bootstrap (bootstrap-new-server.sh / provision-instance.sh) uses
# system-level units under /etc/systemd/system. Override with:
#   HEALTHCHECK_SYSTEMCTL="systemctl --user" ./deploy/healthcheck.sh
if [[ -n "${HEALTHCHECK_SYSTEMCTL:-}" ]]; then
  SYSTEMCTL="$HEALTHCHECK_SYSTEMCTL"
elif systemctl --user is-active llmwiki-api.service >/dev/null 2>&1   || systemctl --user list-unit-files 'llmwiki-*.service' 2>/dev/null | grep -q llmwiki-; then
  SYSTEMCTL="systemctl --user"
else
  SYSTEMCTL="systemctl"
fi

# Service list is overridable for multi-instance groups, e.g.
#   SERVICES="llmwiki-api-inst2 llmwiki-web-inst2" ./deploy/healthcheck.sh
if [[ -n "${SERVICES:-}" ]]; then
  # shellcheck disable=SC2206
  SERVICE_LIST=(${SERVICES})
else
  SERVICE_LIST=("llmwiki-parser.service" "llmwiki-api.service" "llmwiki-web.service")
fi

echo "=================================================="
echo "          LLMWiki Production Healthcheck          "
echo "=================================================="
echo "Checking API on port $API_PORT, Web on port $WEB_PORT"
echo "Service manager: $SYSTEMCTL"

# 1. Check Systemd Services (system-level by default)
echo "[1/4] Checking Systemd Services..."
ALL_SERVICES_OK=true

for svc in "${SERVICE_LIST[@]}"; do
  if $SYSTEMCTL is-active --quiet "$svc"; then
    echo "  ✔ $svc is active (running)"
  else
    echo "  ✘ $svc is NOT active ($($SYSTEMCTL is-active "$svc" 2>/dev/null || echo "unknown"))"
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

# 3. Check API Backend (prefer deep /ready: DB + Redis; fall back to /health)
echo "[3/4] Checking API Backend (port $API_PORT)..."
READY_BODY_FILE="$(mktemp)"
trap 'rm -f "$READY_BODY_FILE"' EXIT
READY_STATUS="$(curl -ksS -o "$READY_BODY_FILE" -w '%{http_code}' "http://127.0.0.1:${API_PORT}/ready" 2>/dev/null || echo "000")"
if [[ "$READY_STATUS" == "200" ]]; then
  echo "  ✔ API Backend /ready returned HTTP 200 (DB + Redis OK)"
elif [[ "$READY_STATUS" == "503" ]]; then
  echo "  ✘ API Backend /ready reported NOT READY: HTTP 503" >&2
  sed 's/^/    /' "$READY_BODY_FILE" >&2 || true
  echo "" >&2
  exit 1
elif [[ "$READY_STATUS" == "404" || "$READY_STATUS" == "000" ]]; then
  # Older builds without /ready: fall back to the shallow liveness probe.
  API_STATUS="$(curl -ksS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || echo "000")"
  if [[ "$API_STATUS" == "200" ]]; then
    echo "  ✔ API Backend /health returned HTTP 200 (/ready unavailable on this build)"
  else
    echo "  ✘ API Backend /health failed: HTTP $API_STATUS" >&2
    exit 1
  fi
else
  echo "  ✘ API Backend /ready failed: HTTP $READY_STATUS" >&2
  sed 's/^/    /' "$READY_BODY_FILE" >&2 || true
  echo "" >&2
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
echo "  - Metrics:     http://127.0.0.1:${API_PORT}/metrics"
echo "  - Parser:      http://127.0.0.1:${PARSER_PORT}"
echo "=================================================="
