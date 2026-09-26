#!/usr/bin/env bash
# Docker-based monitoring install (no GitHub binary downloads).
# Prefer this on networks where github.com is slow/blocked.
#
# Usage:
#   sudo bash deploy/monitoring/install-monitoring-docker.sh
set -Eeuo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p /etc/prometheus/rules /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards/json
mkdir -p /etc/alertmanager/templates

cp "$SRC_DIR/prometheus.yml" /etc/prometheus/prometheus.yml
cp "$SRC_DIR/gbrainkg-alerts.yml" /etc/prometheus/rules/gbrainkg-alerts.yml
cp "$SRC_DIR/grafana-gbrainkg-overview.json" /etc/grafana/provisioning/dashboards/json/gbrainkg-overview.json

cat > /etc/grafana/provisioning/datasources/prometheus.yml <<'DS'
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
DS

cat > /etc/grafana/provisioning/dashboards/gbrainkg.yml <<'DB'
apiVersion: 1
providers:
  - name: gbrainkg
    folder: GBrainKG
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards/json
DB

# ---- Alertmanager config (webhook via env, 企业微信/飞书示例) ----
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
cat > /etc/alertmanager/alertmanager.yml <<'AM'
global:
  resolve_timeout: 5m
route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'webhook'
receivers:
  - name: 'webhook'
    webhook_configs:
      - url: '__ALERT_WEBHOOK_URL__'
        send_resolved: true
AM
if [ -n "$ALERT_WEBHOOK_URL" ]; then
  sed -i "s|__ALERT_WEBHOOK_URL__|${ALERT_WEBHOOK_URL}|g" /etc/alertmanager/alertmanager.yml
else
  # Placeholder keeps AM bootable; point ALERT_WEBHOOK_URL at 企业微信/飞书机器人.
  sed -i "s|__ALERT_WEBHOOK_URL__|http://127.0.0.1:9093/-/healthy|g" /etc/alertmanager/alertmanager.yml
  echo "WARN: ALERT_WEBHOOK_URL empty — Alertmanager webhook is a no-op placeholder."
fi

cat > /etc/alertmanager/templates/wechat.tmpl <<'WT'
{{ define "wechat.default.message" }}
[{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}]
{{ range .Alerts }}
- {{ .Annotations.summary }}
  {{ .Annotations.description }}
  labels: {{ range .Labels.SortedPairs }}{{ .Name }}={{ .Value }} {{ end }}
{{ end }}
{{ end }}
WT

# ---- Optional host/postgres exporters (INSTALL_EXPORTERS=1) ----
if [ "${INSTALL_EXPORTERS:-0}" = "1" ]; then
  echo "Installing node_exporter + postgres_exporter (docker)..."
  docker rm -f gbrainkg-node-exporter 2>/dev/null || true
  docker rm -f gbrainkg-postgres-exporter 2>/dev/null || true
  docker run -d --name gbrainkg-node-exporter --restart unless-stopped \
    --net host --pid host \
    -v /:/host:ro,rslave \
    prom/node-exporter:v1.8.2 \
    --path.rootfs=/host
  # POSTGRES_EXPORTER_DSN e.g. postgres://exporter:pass@127.0.0.1:5432/postgres?sslmode=disable
  POSTGRES_EXPORTER_DSN="${POSTGRES_EXPORTER_DSN:-postgres://postgres:@127.0.0.1:5432/postgres?sslmode=disable}"
  docker run -d --name gbrainkg-postgres-exporter --restart unless-stopped \
    --net host \
    -e DATA_SOURCE_NAME="$POSTGRES_EXPORTER_DSN" \
    prometheuscommunity/postgres-exporter:v0.15.0
  echo "Exporters up: node :9100, postgres :9187"
else
  echo "SKIP exporters (set INSTALL_EXPORTERS=1 to install node_exporter + postgres_exporter)"
fi

# Grafana container runs as uid 472
chown -R 472:472 /etc/grafana/provisioning 2>/dev/null || true

cd "$SRC_DIR"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-$(openssl rand -base64 12 | tr -d '/+=' | head -c 16)}"
export GRAFANA_ADMIN_PASSWORD
docker compose -f docker-compose.monitoring.yml up -d

echo "Waiting for Prometheus..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:9090/-/ready >/dev/null; then
    echo "Prometheus ready"
    break
  fi
  sleep 1
done

echo "=================================================="
echo " Prometheus : http://127.0.0.1:9090  (targets/alerts)"
echo " Grafana    : http://127.0.0.1:3300  user=admin"
echo " Grafana pwd: ${GRAFANA_ADMIN_PASSWORD}   <<< CHANGE ME"
echo " Dashboard  : GBrainKG / gbrainkg-overview"
echo "=================================================="
curl -sf http://127.0.0.1:9090/api/v1/targets | python3 -c "import sys,json;d=json.load(sys.stdin);print('active targets',len(d.get('data',{}).get('activeTargets',[])))" || true
