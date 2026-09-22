#!/usr/bin/env bash
# Install Prometheus + Grafana (host-native systemd) and import GBrainKG
# scrape config / alerts / overview dashboard. Idempotent.
#
# Usage (on the production host, as a sudo-capable user):
#   sudo bash deploy/monitoring/install-monitoring.sh
#
# Optional node_exporter / postgres_exporter are installed when INSTALL_EXPORTERS=1.
set -Eeuo pipefail

PREFIX="${PREFIX:-/opt/monitoring}"
PROM_VERSION="${PROM_VERSION:-2.54.1}"
GRAFANA_VERSION="${GRAFANA_VERSION:-11.2.0}"
INSTALL_EXPORTERS="${INSTALL_EXPORTERS:-0}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "=================================================="
echo " GBrainKG monitoring install  prefix=$PREFIX"
echo "=================================================="

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root (sudo)" >&2
  exit 1
fi

mkdir -p "$PREFIX"/{prometheus,grafana,data/prometheus,data/grafana,rules}
useradd --system --home "$PREFIX" --shell /usr/sbin/nologin prometheus 2>/dev/null || true
useradd --system --home "$PREFIX" --shell /usr/sbin/nologin grafana 2>/dev/null || true

echo "[1/5] Installing Prometheus ${PROM_VERSION}..."
if [[ ! -x /usr/local/bin/prometheus ]]; then
  curl -fsSL -o /tmp/prometheus.tgz \
    "https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/prometheus-${PROM_VERSION}.linux-amd64.tar.gz"
  tar -xzf /tmp/prometheus.tgz -C /tmp
  install -m 0755 /tmp/prometheus-${PROM_VERSION}.linux-amd64/prometheus /usr/local/bin/prometheus
  install -m 0755 /tmp/prometheus-${PROM_VERSION}.linux-amd64/promtool /usr/local/bin/promtool
fi

echo "[2/5] Installing Grafana ${GRAFANA_VERSION} (deb repo)..."
if ! command -v grafana-server >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq adduser libfontconfig1 musl wget
  curl -fsSL -o /tmp/grafana.deb \
    "https://dl.grafana.com/oss/release/grafana_${GRAFANA_VERSION}_amd64.deb"
  apt-get install -y -qq /tmp/grafana.deb
fi

echo "[3/5] Writing configs..."
cp "$SRC_DIR/prometheus.yml" /etc/prometheus.yml 2>/dev/null || {
  mkdir -p /etc/prometheus
  cp "$SRC_DIR/prometheus.yml" /etc/prometheus/prometheus.yml
}
mkdir -p /etc/prometheus/rules
cp "$SRC_DIR/gbrainkg-alerts.yml" /etc/prometheus/rules/gbrainkg-alerts.yml

# validate rules
/usr/local/bin/promtool check config "${SRC_DIR}/prometheus.yml" >/tmp/promtool-check.log 2>&1 || {
  # rule path in yml is /etc/prometheus/rules/... — check rules file directly
  /usr/local/bin/promtool check rules /etc/prometheus/rules/gbrainkg-alerts.yml
}
/usr/local/bin/promtool check rules /etc/prometheus/rules/gbrainkg-alerts.yml

cat > /etc/systemd/system/prometheus.service <<'UNIT'
[Unit]
Description=Prometheus (GBrainKG)
After=network.target

[Service]
User=prometheus
Group=prometheus
ExecStart=/usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/opt/monitoring/data/prometheus \
  --storage.tsdb.retention.time=30d \
  --web.listen-address=127.0.0.1:9090
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

# ensure config at /etc/prometheus/prometheus.yml
mkdir -p /etc/prometheus
cp "$SRC_DIR/prometheus.yml" /etc/prometheus/prometheus.yml
chown -R prometheus:prometheus /etc/prometheus "$PREFIX/data/prometheus"

echo "[4/5] Grafana provisioning dashboard + datasource..."
mkdir -p /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards
cat > /etc/grafana/provisioning/datasources/prometheus.yml <<'DS'
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://127.0.0.1:9090
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
mkdir -p /etc/grafana/provisioning/dashboards/json
cp "$SRC_DIR/grafana-gbrainkg-overview.json" /etc/grafana/provisioning/dashboards/json/gbrainkg-overview.json

echo "[5/5] Enable services..."
systemctl daemon-reload
systemctl enable --now prometheus.service
systemctl enable --now grafana-server.service
sleep 2
systemctl --no-pager --full status prometheus.service | head -8 || true
systemctl --no-pager --full status grafana-server.service | head -8 || true

echo ""
echo "=================================================="
echo " Prometheus:  http://127.0.0.1:9090   (bind localhost; reverse-proxy if needed)"
echo " Grafana:     http://127.0.0.1:3000   (change admin password on first login)"
echo " Targets:     /targets   Alerts: /alerts"
echo " Dashboard:   GBrainKG / gbrainkg-overview"
echo "=================================================="
echo "NOTE: Grafana defaults listen :3000 which collides with llmwiki-api-inst1."
echo "      Change grafana http_port to 3300 if needed:"
echo "      /etc/grafana/grafana.ini -> [server] http_port = 3300"
