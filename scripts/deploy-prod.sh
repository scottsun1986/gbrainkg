#!/usr/bin/env bash
# GBrainKG 生产发布脚本（本机 → meetings2）
# 用法: bash scripts/deploy-prod.sh [--skip-build]
# 前置: 本地 apps/api/dist 与 apps/web/.next 已构建（pnpm --filter api build && pnpm --filter web build）
#
# 生产布局（2026-09 起）:
#   代码:   /home/ubuntu/gbrainkg          （systemd ExecStart 指向此处）
#   数据盘: /data/llmwiki/{postgres,runtime,gbrain-data,appdata}
#           /data/backups/{deploy-backups,home-backups}
#          以上均通过原路径符号链接回 /home/ubuntu、/var/lib/postgresql，
#          因此 rsync 目标路径与 systemd 单元无需改动。
set -euo pipefail

PROD_HOST="${PROD_HOST:-meetings2}"
LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="inst1"
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --target=*) TARGET="${arg#*=}" ;;
    inst1|--inst1) TARGET="inst1" ;;
    inst2|--inst2) TARGET="inst2" ;;
  esac
done

if [[ "$TARGET" == "inst2" ]]; then
  PROD_REPO="${PROD_REPO:-/home/ubuntu/gbrainkg-inst2}"
  API_SERVICE="llmwiki-api-inst2"
  WEB_SERVICE="llmwiki-web-inst2"
  API_PORT=3002
  WEB_PORT=3201
  PUBLIC_PORT=20081
  DATA_DIR="/data/llmwiki-inst2"
else
  PROD_REPO="${PROD_REPO:-/home/ubuntu/gbrainkg}"
  API_SERVICE="llmwiki-api"
  WEB_SERVICE="llmwiki-web"
  API_PORT=3000
  WEB_PORT=3200
  PUBLIC_PORT=20080
  DATA_DIR="/data/llmwiki"
fi

log() { echo "[deploy-prod $(date '+%F %T')] [target=$TARGET] $*"; }

# ---- 1. 本地构建校验 ----
if [[ "$SKIP_BUILD" == false ]]; then
  log "[1/6] Building api + web ..."
  (cd "$LOCAL_ROOT/apps/api" && pnpm build)
  (cd "$LOCAL_ROOT/apps/web" && pnpm build)
else
  log "[1/6] Skip build (--skip-build), expecting existing dist/.next"
fi
[[ -f "$LOCAL_ROOT/apps/api/dist/main.js" ]] || { log "ERROR: apps/api/dist/main.js missing"; exit 1; }
[[ -d "$LOCAL_ROOT/apps/web/.next" ]] || { log "ERROR: apps/web/.next missing"; exit 1; }

# ---- 2. 生产前置检查 ----
log "[2/6] Preflight checks on $PROD_HOST for $TARGET ..."
ssh "$PROD_HOST" "
  set -e
  mountpoint -q /data || { echo 'ERROR: /data not mounted'; exit 1; }
  [[ -d '$DATA_DIR' ]] || { echo 'ERROR: $DATA_DIR missing'; exit 1; }
  [[ -d '$PROD_REPO' || -L '$PROD_REPO' ]] || { echo 'ERROR: $PROD_REPO missing'; exit 1; }
  df -h / /data | tail -2
"

# ---- 3. 同步代码与构建产物 ----
log "[3/6] Rsync code + builds to $PROD_REPO ..."
rsync -az --info=stats1 \
  --exclude='.git' --exclude='node_modules' --exclude='.next/cache' \
  --exclude='.env*' --exclude='runtime' --exclude='scratch' \
  --exclude='screenshots' --exclude='.playwright-mcp' --exclude='.turbo' \
  --exclude='.pytest_cache' --exclude='.secrets' --exclude='.agents' \
  --exclude='docs' --exclude='design' --exclude='deploy' \
  "$LOCAL_ROOT/" "$PROD_HOST:$PROD_REPO/"

# ---- 4. 依赖安装与迁移 ----
log "[4/6] pnpm install on production ($TARGET) ..."
ssh "$PROD_HOST" "cd $PROD_REPO && export PATH=\$HOME/.local/bin:\$HOME/.hermes/node/bin:\$PATH && pnpm install --frozen-lockfile=false | tail -2"

# ---- 5. 重启指定实例的服务 ----
log "[5/6] Restarting $API_SERVICE and $WEB_SERVICE on $PROD_HOST ..."
ssh "$PROD_HOST" "sudo systemctl restart $API_SERVICE $WEB_SERVICE && sleep 5 && systemctl is-active $API_SERVICE $WEB_SERVICE"

# ---- 6. 健康检查 ----
log "[6/6] Health checks for $TARGET ..."
ssh "$PROD_HOST" "
  curl -sf http://127.0.0.1:$API_PORT/health >/dev/null && echo 'api ($API_PORT): ok'
  curl -sf http://127.0.0.1:$WEB_PORT/ >/dev/null && echo 'web ($WEB_PORT): ok'
  curl -sk --resolve knowledge.5gsailor.com:$PUBLIC_PORT:127.0.0.1 -o /dev/null -w 'public https ($PUBLIC_PORT): %{http_code}\n' https://knowledge.5gsailor.com:$PUBLIC_PORT/health
"
log "Deploy complete for $TARGET."
