#!/usr/bin/env bash
# ==============================================================================
# GBrainKG 生产发布与多实例统一运维脚本（本机 → meetings2）
# ==============================================================================
# 用法:
#   bash scripts/deploy-prod.sh --target=all         # 同时发布实例1与实例2（推荐）
#   bash scripts/deploy-prod.sh --target=inst1       # 仅发布实例1（主客户：20080端口）
#   bash scripts/deploy-prod.sh --target=inst2       # 仅发布实例2（独立客户：20081端口）
#   bash scripts/deploy-prod.sh --skip-build ...     # 跳过本地构建，直接发布现有产物
#
# ==============================================================================
# 【核心原则：极简资源节省型多实例部署架构（Resource-Saving Multi-Instance Architecture）】
# 后续在生产服务器上扩展部署实例 3、4... 等新客户实例时，必须全部遵循此模式：
#
# 1. 基础中间件全共享（零重复开销）：
#    - PostgreSQL 16：全局单实例，按数据库逻辑隔离（llmwiki, llmwiki_inst2, llmwiki_inst3...）
#    - Redis 7：全局单实例，按 DB 索引逻辑隔离（实例1=DB 0, 实例2=DB 1, 实例3=DB 2...）
#    - Parser-Worker：全局单实例（8100端口），共享 Python/Docling 文档解析多进程池，
#      严禁为每个实例重复拉起重型 Python/AI 解析后台，避免浪费大量显存/内存
#    - MinIO：全局单实例（9000端口），统一对象存储服务
#    - Nginx 反向代理：全局单实例，复用 wildcard/SAN SSL 证书，以高端口段做网关路由
#
# 2. 实例专属进程仅保留轻量 Node.js（极低内存）：
#    - 每个实例仅包含 2 个极轻量的系统服务：
#      * llmwiki-api-instN (NestJS, 内存 ~60MB, 限制 2GB)
#      * llmwiki-web-instN (Next.js, 内存 ~50MB, 限制 1GB)
#    - 相比起整套独立 Docker 容器或全量中间件，单台 16G/32G 服务器可稳定承载 10+ 独立实例。
#
# 3. 存储与磁盘规范：
#    - 所有实例代码与运行时数据必须存放大容量数据盘 /data（挂载点）：
#      * 实例1：/data/llmwiki/{runtime,uploads} -> 软链至 /home/ubuntu/gbrainkg
#      * 实例2：/data/llmwiki-inst2/{runtime,uploads,code} -> 软链至 /home/ubuntu/gbrainkg-inst2
#      * 实例N：/data/llmwiki-instN/...
#    - 严禁向系统根分区 / 写入大文件，防止磁盘写满导致全机服务不可用。
#
# 4. 端口规划标准：
#    | 实例标识 | API 端口 | Web 端口 | 公网 HTTPS 端口 | 数据库名       | Redis DB |
#    |----------|----------|----------|-----------------|----------------|----------|
#    | inst1    | 3000     | 3200     | 20080           | llmwiki        | 0        |
#    | inst2    | 3002     | 3201     | 20081           | llmwiki_inst2  | 1        |
#    | inst3    | 3004     | 3202     | 20082           | llmwiki_inst3  | 2        |
#    | instN    | 3000+2(N-1)| 3200+(N-1)| 20080+(N-1)   | llmwiki_instN  | N-1      |
# ==============================================================================

set -euo pipefail

PROD_HOST="${PROD_HOST:-meetings2}"
LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="all"
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --target=*) TARGET="${arg#*=}" ;;
    inst1|--inst1) TARGET="inst1" ;;
    inst2|--inst2) TARGET="inst2" ;;
    all|--all) TARGET="all" ;;
  esac
done

log() { echo "[deploy-prod $(date '+%F %T')] $*"; }

# ---- 1. 本地全量构建与校验 ----
if [[ "$SKIP_BUILD" == false ]]; then
  log "[1/5] Building api + web locally with turbo..."
  (cd "$LOCAL_ROOT" && pnpm build)
else
  log "[1/5] Skip build (--skip-build), expecting existing dist/.next"
fi
[[ -f "$LOCAL_ROOT/apps/api/dist/main.js" ]] || { log "ERROR: apps/api/dist/main.js missing"; exit 1; }
[[ -d "$LOCAL_ROOT/apps/web/.next" ]] || { log "ERROR: apps/web/.next missing"; exit 1; }

# ---- 2. 部署单个实例函数 ----
deploy_single_instance() {
  local inst="$1"
  local prod_repo api_service web_service api_port web_port public_port data_dir env_file
  
  if [[ "$inst" == "inst2" ]]; then
    prod_repo="/data/llmwiki-inst2/code"
    api_service="llmwiki-api-inst2"
    web_service="llmwiki-web-inst2"
    api_port=3002
    web_port=3201
    public_port=20081
    data_dir="/data/llmwiki-inst2"
    env_file="/home/ubuntu/.config/llmwiki/production-inst2.env"
  else
    prod_repo="/home/ubuntu/gbrainkg"
    api_service="llmwiki-api"
    web_service="llmwiki-web"
    api_port=3000
    web_port=3200
    public_port=20080
    data_dir="/data/llmwiki"
    env_file="/home/ubuntu/.config/llmwiki/production.env"
  fi

  log ">>> Deploying target: $inst ($api_service, $web_service, port $public_port) <<<"

  # 2.1 检查前置
  ssh "$PROD_HOST" "
    set -e
    mountpoint -q /data || { echo 'ERROR: /data not mounted'; exit 1; }
    [[ -d '$data_dir' ]] || { echo 'ERROR: $data_dir missing'; exit 1; }
    [[ -d '$prod_repo' || -L '$prod_repo' ]] || { echo 'ERROR: $prod_repo missing'; exit 1; }
    [[ -f '$env_file' ]] || { echo 'ERROR: $env_file missing'; exit 1; }
  "

  # 2.2 Rsync 代码与构建产物
  log "[$inst] Synchronizing code + dist..."
  rsync -az --info=stats1 \
    --exclude='.git' --exclude='node_modules' --exclude='.next/cache' \
    --exclude='.env*' --exclude='runtime' --exclude='scratch' \
    --exclude='screenshots' --exclude='.playwright-mcp' --exclude='.turbo' \
    --exclude='.pytest_cache' --exclude='.secrets' --exclude='.agents' \
    --exclude='docs' --exclude='design' \
    "$LOCAL_ROOT/" "$PROD_HOST:$prod_repo/"

  # 2.3 依赖安装与数据库迁移
  log "[$inst] Running database migration & pnpm install..."
  ssh "$PROD_HOST" "
    set -e
    export PATH=\$HOME/.local/bin:\$HOME/.hermes/node/bin:\$PATH
    cd '$prod_repo'
    pnpm install --frozen-lockfile=false | tail -2
    cd '$prod_repo/packages/database'
    export \$(grep -E '^DATABASE_URL=' '$env_file' | xargs)
    npx prisma migrate deploy
  "

  # 2.4 重启专属系统服务
  log "[$inst] Restarting $api_service and $web_service..."
  ssh "$PROD_HOST" "
    sudo systemctl restart '$api_service' '$web_service'
    sleep 3
    systemctl is-active '$api_service' '$web_service'
  "

  # 2.5 健康检查
  log "[$inst] Verifying health..."
  ssh "$PROD_HOST" "
    curl -sf 'http://127.0.0.1:$api_port/open-api/spec.json' >/dev/null && echo '  - API (port $api_port): OK'
    curl -sf 'http://127.0.0.1:$web_port/' >/dev/null && echo '  - Web (port $web_port): OK'
    curl -sk --resolve knowledge.5gsailor.com:$public_port:127.0.0.1 -o /dev/null -w '  - Public HTTPS ($public_port): HTTP %{http_code}\n' 'https://knowledge.5gsailor.com:$public_port/'
  "
  log "[$inst] Successfully deployed!"
}

# ---- 3. 执行发布计划 ----
if [[ "$TARGET" == "all" ]]; then
  log "Starting batch deployment to ALL production instances (inst1, inst2)..."
  deploy_single_instance "inst1"
  echo ""
  deploy_single_instance "inst2"
  log "All instances deployed successfully!"
elif [[ "$TARGET" == "inst1" || "$TARGET" == "inst2" ]]; then
  deploy_single_instance "$TARGET"
else
  log "ERROR: Unknown target '$TARGET'. Choose 'inst1', 'inst2', or 'all'."
  exit 1
fi
