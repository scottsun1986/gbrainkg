#!/usr/bin/env bash
# ==============================================================================
# Deploy to the demo environment (150.158.137.151:50003).
#
# Demo data is disposable: NO pre-release snapshot is taken. The demo box has a
# 40 GB disk and a full source snapshot reached 4.6 GB, which twice pushed the
# filesystem past 95%. Production keeps its snapshot (deploy-prod.sh); do not
# copy that behaviour here.
#
# Usage: bash scripts/deploy-demo.sh [--skip-build]
# ==============================================================================
set -Eeuo pipefail

DEMO_HOST="${DEMO_HOST:-ubuntu@150.158.137.151}"
DEMO_ROOT="${DEMO_ROOT:-gbrainkg}"
SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

command -v sshpass >/dev/null || die "sshpass is required for the demo host"
[[ -n "${DEMO_SSH_PASSWORD:-}" ]] || die "set DEMO_SSH_PASSWORD (or configure a key)"

ssh_demo() { SSHPASS="$DEMO_SSH_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=accept-new "$DEMO_HOST" "$@"; }

log "Preflight: demo host reachable and services present"
ssh_demo 'test -d ~/'"$DEMO_ROOT"' || { echo "missing repo"; exit 1; }; echo ok' >/dev/null \
  || die "demo host not reachable or repo missing"

# Sync sources only. Data, secrets, build outputs and dependencies stay put so
# the demo instance keeps its corpus and its installed parser venv.
log "Rsync sources (no snapshot: demo data is disposable)"
# `.next-live` is the directory the running Next.js server writes into, and
# docs/validation holds operator notes; rsync must not try to delete either.
SSHPASS="$DEMO_SSH_PASSWORD" sshpass -e rsync -az --delete \
  --exclude='.git/' --exclude='.releases/' --exclude='node_modules/' --exclude='.next/' \
  --exclude='.next-live/' --exclude='docs/validation/' --exclude='dist/' \
  --exclude='.venv/' --exclude='runtime/' --exclude='uploads/' \
  --exclude='.secrets/' --exclude='*.log' --exclude='.env' --exclude='.env.local' \
  -e 'ssh -o StrictHostKeyChecking=accept-new' \
  ./ "$DEMO_HOST:~/${DEMO_ROOT}/"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "Build on demo host (demo-build.sh: install, prisma generate, migrate, api, web, parser venv)"
  ssh_demo 'bash ~/demo-build.sh' | tail -20
  [[ "${PIPESTATUS[0]}" -eq 0 ]] || die "demo build failed"
fi

log "Verifying demo services"
ssh_demo '
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:50003/)
  [[ "$code" == "200" ]] || { echo "web 50003 -> $code"; exit 1; }
  curl -sf http://127.0.0.1:3202/ready >/dev/null || { echo "api not ready"; exit 1; }
  curl -sf http://127.0.0.1:8100/health >/dev/null || { echo "parser unhealthy"; exit 1; }
  echo "web 50003 -> 200; api ready; parser healthy"
  df -h / | tail -1
'

log "DEMO DEPLOY OK"