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
PROD_REPO="${PROD_REPO:-/home/ubuntu/gbrainkg}"
LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_BUILD=false
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=true

log() { echo "[deploy-prod $(date '+%F %T')] $*"; }

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
log "[2/6] Preflight checks on $PROD_HOST ..."
ssh "$PROD_HOST" '
  set -e
  mountpoint -q /data || { echo "ERROR: /data not mounted"; exit 1; }
  for p in /data/llmwiki/postgres /data/llmwiki/runtime /data/llmwiki/gbrain-data /data/llmwiki/appdata; do
    [[ -d "$p" ]] || { echo "ERROR: $p missing"; exit 1; }
  done
  [[ -L /var/lib/postgresql && -L /home/ubuntu/gbrainkg/runtime ]] || { echo "ERROR: migration symlinks missing"; exit 1; }
  df -h / /data | tail -2
'

# ---- 3. 同步代码与构建产物 ----
log "[3/6] Rsync code + builds ..."
rsync -az --info=stats1 \
  --exclude='.git' --exclude='node_modules' --exclude='.next/cache' \
  --exclude='.env*' --exclude='runtime' --exclude='scratch' \
  --exclude='screenshots' --exclude='.playwright-mcp' --exclude='.turbo' \
  --exclude='.pytest_cache' --exclude='.secrets' --exclude='.agents' \
  --exclude='docs' --exclude='design' --exclude='deploy' \
  "$LOCAL_ROOT/" "$PROD_HOST:$PROD_REPO/"

# ---- 4. 依赖安装 ----
log "[4/6] pnpm install on production ..."
ssh "$PROD_HOST" "cd $PROD_REPO && export PATH=\$HOME/.local/bin:\$HOME/.hermes/node/bin:\$PATH && pnpm install --frozen-lockfile=false | tail -2"

# ---- 5. 重启服务 ----
log "[5/6] Restarting services ..."
ssh "$PROD_HOST" 'sudo systemctl restart llmwiki-api llmwiki-web && sleep 8 && systemctl is-active llmwiki-api llmwiki-web llmwiki-parser'

# ---- 6. 健康检查 ----
log "[6/6] Health checks ..."
ssh "$PROD_HOST" '
  curl -sf http://127.0.0.1:3000/health >/dev/null && echo "api: ok"
  curl -sf http://127.0.0.1:3200/ >/dev/null && echo "web: ok"
  curl -sk --resolve knowledge.5gsailor.com:20080:127.0.0.1 -o /dev/null -w "public https: %{http_code}\n" https://knowledge.5gsailor.com:20080/health
'
log "Deploy complete."
