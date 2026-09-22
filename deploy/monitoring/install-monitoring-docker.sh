#!/usr/bin/env bash
# Docker-based monitoring install (no GitHub binary downloads).
# Prefer this on networks where github.com is slow/blocked.
#
# Usage:
#   sudo bash deploy/monitoring/install-monitoring-docker.sh
set -Eeuo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p /etc/prometheus/rules /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards/json

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

# Grafana container runs as uid 472
chown -R 472:472 /etc/grafana/provisioning 2>/dev/null || true

cd "$SRC_DIR"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-$(openssl rand -base64 12 | tr -d '/+=' | head -c 16)}" \
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
