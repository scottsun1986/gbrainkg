#!/usr/bin/env bash
# Publish Prometheus + Grafana under the production domain with HTTP basic auth.
#
#   https://knowledge.5gsailor.com:20080/monitor/
#   https://knowledge.5gsailor.com:20080/monitor/grafana/
#   https://knowledge.5gsailor.com:20080/monitor/prometheus/
#
# Usage (on meetings2):
#   sudo bash deploy/monitoring/expose-monitoring-vhost.sh
#   MONITOR_USER=ops MONITOR_PASS=... sudo -E bash deploy/monitoring/expose-monitoring-vhost.sh
set -Eeuo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE=/etc/nginx/sites-enabled/llmwiki
MONITOR_USER="${MONITOR_USER:-ops}"
MONITOR_PASS="${MONITOR_PASS:-$(openssl rand -base64 15 | tr -d '/+=' | head -c 16)}"
BASE_URL="${MONITOR_BASE_URL:-https://knowledge.5gsailor.com:20080}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root (sudo)" >&2
  exit 1
fi

echo "[1/5] basic-auth user '${MONITOR_USER}'"
if ! command -v htpasswd >/dev/null 2>&1; then
  apt-get install -y -qq apache2-utils >/dev/null
fi
htpasswd -bc /etc/nginx/.htpasswd_monitor "$MONITOR_USER" "$MONITOR_PASS"
chmod 640 /etc/nginx/.htpasswd_monitor
chown root:www-data /etc/nginx/.htpasswd_monitor

echo "[2/5] Grafana root URL = ${BASE_URL}/monitor/grafana/"
mkdir -p /etc/grafana
if [[ -f /etc/grafana/grafana.ini ]]; then
  sed -i 's#^;*root_url = .*#root_url = '"${BASE_URL}"'/monitor/grafana/#' /etc/grafana/grafana.ini
  grep -q '^serve_from_sub_path' /etc/grafana/grafana.ini \
    && sed -i 's#^;*serve_from_sub_path = .*#serve_from_sub_path = true#' /etc/grafana/grafana.ini \
    || echo 'serve_from_sub_path = true' >> /etc/grafana/grafana.ini
fi
# docker provisioning override
cat > /etc/grafana/grafana-monitor.env <<EOF
GF_SERVER_ROOT_URL=${BASE_URL}/monitor/grafana/
GF_SERVER_DOMAIN=knowledge.5gsailor.com
GF_SERVER_SERVE_FROM_SUB_PATH=true
GF_USERS_ALLOW_SIGN_UP=false
EOF

echo "[3/5] Prometheus external-url / route-prefix"
# Patch docker-compose command via an override file so upstream stays clean.
cat > /etc/prometheus/prometheus-flags.txt <<EOF
--config.file=/etc/prometheus/prometheus.yml
--storage.tsdb.path=/prometheus
--storage.tsdb.retention.time=30d
--web.listen-address=0.0.0.0:9090
--web.external-url=${BASE_URL}/monitor/prometheus/
--web.route-prefix=/monitor/prometheus
--web.enable-lifecycle
EOF

echo "[4/5] nginx locations"
cp "$SRC_DIR/nginx-monitor-locations.conf" /etc/nginx/snippets/monitor-locations.conf
if ! grep -q 'monitor-locations.conf' "$SITE"; then
  # insert include just before the final `location /` of the 20080 server
  python3 - "$SITE" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
snippet = '''
    # --- GBrainKG monitoring (basic-auth) ---
    include /etc/nginx/snippets/monitor-locations.conf;

'''
needle = '''    location / {
        proxy_pass http://127.0.0.1:3200;'''
if needle not in text:
    # insert before last closing brace of file as fallback
    raise SystemExit('anchor location / not found — add include manually')
text = text.replace(needle, snippet + needle, 1)
open(path, 'w').write(text)
print('inserted include')
PY
else
  echo "  include already present"
fi

echo "[5/5] reload stack"
# Grafana container: pass root-url via compose override
cd "$SRC_DIR"
if docker ps --format '{{.Names}}' | grep -q gbrainkg-grafana; then
  docker stop gbrainkg-grafana >/dev/null
  docker rm gbrainkg-grafana >/dev/null
fi
docker run -d --name gbrainkg-grafana --restart unless-stopped \
  -p 127.0.0.1:3300:3000 \
  --env-file /etc/grafana/grafana-monitor.env \
  -e GF_SECURITY_ADMIN_USER="${GRAFANA_USER:-admin}" \
  -e GF_SECURITY_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-admin}" \
  -v grafana-data:/var/lib/grafana \
  -v /etc/grafana/provisioning:/etc/grafana/provisioning:ro \
  grafana/grafana:11.2.0

if docker ps --format '{{.Names}}' | grep -q gbrainkg-prometheus; then
  docker stop gbrainkg-prometheus >/dev/null
  docker rm gbrainkg-prometheus >/dev/null
fi
# host network so 127.0.0.1 scrape targets reach host APIs
docker run -d --name gbrainkg-prometheus --restart unless-stopped \
  --network host \
  -v /etc/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro \
  -v /etc/prometheus/rules:/etc/prometheus/rules:ro \
  -v prometheus-data:/prometheus \
  prom/prometheus:v2.54.1 \
  $(tr '\n' ' ' < /etc/prometheus/prometheus-flags.txt)

nginx -t
systemctl reload nginx

echo ""
echo "=================================================="
echo " Monitor landing : ${BASE_URL}/monitor/"
echo " Grafana         : ${BASE_URL}/monitor/grafana/"
echo " Prometheus      : ${BASE_URL}/monitor/prometheus/"
echo " basic-auth user : ${MONITOR_USER}"
echo " basic-auth pass : ${MONITOR_PASS}   <<< 记下并改掉"
echo "=================================================="
curl -sSI "${BASE_URL}/monitor/" | head -5 || true
