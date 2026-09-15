#!/usr/bin/env bash
# ==============================================================================
# GBrainKG 生产发布与多实例统一运维脚本（本机 → meetings2）
# ==============================================================================
# 用法:
#   bash scripts/deploy-prod.sh --target=all         # 自动发现并批量发布全部生产实例（推荐）
#   bash scripts/deploy-prod.sh --target=inst1       # 仅发布实例1（主客户：20080端口）
#   bash scripts/deploy-prod.sh --target=inst2       # 仅发布实例2（独立客户：20081端口）
#   bash scripts/deploy-prod.sh --target=instN       # 发布任意指定实例N（如 inst3）
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
    inst*|--inst*) TARGET="${arg#--}" ;;
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

# ---- 2. 实例参数解析函数 ----
resolve_instance_params() {
  local inst="$1"
  if [[ "$inst" == "inst1" || "$inst" == "1" ]]; then
    INST_NAME="inst1"
    INST_NUM=1
    PROD_REPO="/home/ubuntu/gbrainkg"
    API_SERVICE="llmwiki-api"
    WEB_SERVICE="llmwiki-web"
    API_PORT=3000
    WEB_PORT=3200
    PUBLIC_PORT=20080
    DATA_DIR="/data/llmwiki"
    ENV_FILE="/home/ubuntu/.config/llmwiki/production.env"
    EXPECTED_REDIS_DB=0
    DB_NAME="llmwiki"
  elif [[ "$inst" =~ ^inst([0-9]+)$ || "$inst" =~ ^([0-9]+)$ ]]; then
    INST_NUM="${BASH_REMATCH[1]}"
    local offset=$((INST_NUM - 1))
    INST_NAME="inst${INST_NUM}"
    PROD_REPO="/data/llmwiki-inst${INST_NUM}/code"
    API_SERVICE="llmwiki-api-inst${INST_NUM}"
    WEB_SERVICE="llmwiki-web-inst${INST_NUM}"
    API_PORT=$((3000 + 2 * offset))
    WEB_PORT=$((3200 + offset))
    PUBLIC_PORT=$((20080 + offset))
    DATA_DIR="/data/llmwiki-inst${INST_NUM}"
    ENV_FILE="/home/ubuntu/.config/llmwiki/production-inst${INST_NUM}.env"
    EXPECTED_REDIS_DB=$offset
    DB_NAME="llmwiki_inst${INST_NUM}"
  else
    log "ERROR: Invalid instance target '$inst'. Choose 'instN' (e.g. inst1, inst2) or 'all'."
    exit 1
  fi
}

# ---- 3. 部署单个实例函数 ----
deploy_single_instance() {
  local target_inst="$1"
  resolve_instance_params "$target_inst"

  log ">>> Deploying target: $INST_NAME ($API_SERVICE, $WEB_SERVICE, port $PUBLIC_PORT, DB $DB_NAME, Redis DB $EXPECTED_REDIS_DB) <<<"

  # 3.1 检查前置与强隔离防线（重点防止跨实例队列串号与权限缺失）
  ssh "$PROD_HOST" "
    set -e
    mountpoint -q /data || { echo 'ERROR: /data not mounted'; exit 1; }
    [[ -d '$DATA_DIR' ]] || { echo 'ERROR: $DATA_DIR missing'; exit 1; }
    [[ -d '$PROD_REPO' || -L '$PROD_REPO' ]] || { echo 'ERROR: $PROD_REPO missing'; exit 1; }
    [[ -f '$ENV_FILE' ]] || { echo 'ERROR: $ENV_FILE missing'; exit 1; }

    # 强校验：检查 REDIS_DB 配置，杜绝任何多实例连入同一 Redis 库导致的任务抢占卡死缺陷
    actual_redis=\$(grep -E '^REDIS_DB=' '$ENV_FILE' | cut -d= -f2 | tr -cd 0-9 || echo '')
    actual_redis=\${actual_redis:-0}
    if [[ \"\$actual_redis\" -ne \"$EXPECTED_REDIS_DB\" ]]; then
      echo '========================================================================'
      echo 'CRITICAL ERROR: Redis DB Isolation Violation!'
      echo \"Target instance: $INST_NAME requires REDIS_DB=$EXPECTED_REDIS_DB\"
      echo \"Configured file: $ENV_FILE has REDIS_DB=\$actual_redis\"
      echo 'Aborting deployment to prevent queue interference and stalled indexing!'
      echo '========================================================================'
      exit 1
    fi

    # 校验并补齐 postgresql 角色权限
    sudo -u postgres psql -tAc \"SELECT rolbypassrls FROM pg_roles WHERE rolname='llmwiki'\" | grep -q t || {
      echo 'Granting BYPASSRLS to role llmwiki...'
      sudo -u postgres psql -c \"ALTER ROLE llmwiki BYPASSRLS;\"
    }
  "

  # 3.2 Rsync 代码与构建产物
  log "[$INST_NAME] Synchronizing code + dist..."
  rsync -az --info=stats1 \
    --exclude='.git' --exclude='node_modules' --exclude='.next/cache' \
    --exclude='.env*' --exclude='runtime' --exclude='scratch' \
    --exclude='screenshots' --exclude='.playwright-mcp' --exclude='.turbo' \
    --exclude='.pytest_cache' --exclude='.secrets' --exclude='.agents' \
    --exclude='docs' --exclude='design' \
    "$LOCAL_ROOT/" "$PROD_HOST:$PROD_REPO/"

  # 3.3 依赖安装、Prisma 迁移与 GBrain 迁移
  log "[$INST_NAME] Running database migrations & pnpm install..."
  ssh "$PROD_HOST" "
    set -e
    export PATH=\$HOME/.local/bin:\$HOME/.hermes/node/bin:/usr/local/bin:\$PATH
    cd '$PROD_REPO'
    pnpm install --frozen-lockfile=false | tail -2
    cd '$PROD_REPO/packages/database'
    set -a
    source '$ENV_FILE'
    set +a
    npx prisma migrate deploy

    # 执行 GBrain 底座迁移，确保 pages / content_chunks 架构同步
    gbrain apply-migrations --yes || true

    # 自动初始化基础角色与超级管理员账号（默认密码 123456，若已存在则安全跳过）
    ADMIN_INITIAL_PASSWORD="${ADMIN_INITIAL_PASSWORD:-123456}" node "$PROD_REPO/apps/api/dist/bootstrap/production-bootstrap.js" || true
  "

  # 3.4 重启专属系统服务
  log "[$INST_NAME] Restarting $API_SERVICE and $WEB_SERVICE..."
  ssh "$PROD_HOST" "
    sudo systemctl restart '$API_SERVICE' '$WEB_SERVICE'
    sleep 3
    systemctl is-active '$API_SERVICE' '$WEB_SERVICE'
  "

  # 3.5 健康巡检与 GBrain 状态校验
  log "[$INST_NAME] Verifying health..."
  ssh "$PROD_HOST" "
    curl -sf 'http://127.0.0.1:$API_PORT/open-api/spec.json' >/dev/null && echo '  - API (port $API_PORT): OK'
    curl -sf 'http://127.0.0.1:$WEB_PORT/' >/dev/null && echo '  - Web (port $WEB_PORT): OK'
    domain=\$(grep -E '^WEB_ORIGIN=' '$ENV_FILE' | sed -E 's|^WEB_ORIGIN=https?://([^:/]+).*|\1|' || echo '127.0.0.1')
    scheme=\$(grep -E '^WEB_ORIGIN=' '$ENV_FILE' | grep -q '^WEB_ORIGIN=https://' && echo 'https' || echo 'http')
    curl -sk --resolve \"\$domain:$PUBLIC_PORT:127.0.0.1\" -o /dev/null -w \"  - Public Gateway (\$PUBLIC_PORT): HTTP %{http_code}\n\" \"\$scheme://\$domain:$PUBLIC_PORT/\" || echo \"  - Public Gateway (\$PUBLIC_PORT): skipped\"
    set -a
    source '$ENV_FILE'
    set +a
    gbrain sources status --json >/dev/null && echo '  - GBrain engine status: OK'
  "
  log "[$INST_NAME] Successfully deployed!"
}

# ---- 4. 执行发布计划 ----
if [[ "$TARGET" == "all" ]]; then
  log "Discovering all configured instances on $PROD_HOST..."
  INSTANCES=()
  if ssh "$PROD_HOST" "[[ -f /home/ubuntu/.config/llmwiki/production.env ]]"; then
    INSTANCES+=("inst1")
  fi
  REMOTE_INST_NUMS=$(ssh "$PROD_HOST" "ls /home/ubuntu/.config/llmwiki/production-inst*.env 2>/dev/null" | grep -oE 'inst[0-9]+' | sort -u -V || true)
  for inst in $REMOTE_INST_NUMS; do
    INSTANCES+=("$inst")
  done

  log "Found active instance(s): ${INSTANCES[*]}"
  for inst in "${INSTANCES[@]}"; do
    echo ""
    deploy_single_instance "$inst"
  done
  log "All discovered instances (${INSTANCES[*]}) deployed successfully!"
else
  deploy_single_instance "$TARGET"
fi
