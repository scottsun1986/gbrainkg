#!/usr/bin/env bash
# ==============================================================================
# GBrainKG 生产发布与多实例统一运维脚本（本机 → meetings2）
# ==============================================================================
# 用法:
#   bash scripts/deploy-prod.sh --help                   # 查看完整用法
#   bash scripts/deploy-prod.sh --target=all             # 自动发现并批量发布全部生产实例（推荐）
#   bash scripts/deploy-prod.sh --target=inst1           # 仅发布实例1（主客户：20080端口）
#   bash scripts/deploy-prod.sh --target=inst2           # 仅发布实例2（独立客户：20081端口）
#   bash scripts/deploy-prod.sh --target=instN           # 发布任意指定实例N（如 inst3）
#   bash scripts/deploy-prod.sh --skip-build ...         # 跳过本地构建，直接发布现有产物
#   bash scripts/deploy-prod.sh --skip-gate ...          # 跳过发布门禁（会打警告，不推荐）
#   bash scripts/deploy-prod.sh --rollback previous --target=inst1
#   bash scripts/deploy-prod.sh --rollback <timestamp> --target=inst1
#   bash scripts/deploy-prod.sh --rollback=list --target=inst1
#
# 发布门禁 (P0):
#   默认先执行 `GATE_STRICT=1 bash scripts/ci.sh`，失败即中止发布。
#   可用 --skip-gate 显式跳过（打印警告）。
#
# 发布前快照 / 回滚 (P0):
#   每次 rsync 前把当前 $PROD_REPO 状态备份到 $PROD_REPO/.releases/<timestamp>/：
#     manifest.json  — git SHA、.env 哈希、apps/api/package.json 版本、树摘要等
#     tree.tar.gz    — 可恢复的代码/构建产物树（不含 node_modules/.env/.git）
#   --rollback previous|<timestamp> 按 manifest 回切代码（git checkout 或快照恢复）、
#   重装锁文件依赖、重启服务、curl 健康检查；回滚失败非零退出。
#   健康检查失败只提示回滚命令，不自动回滚（避免误伤）。
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
SKIP_GATE=false
ROLLBACK_MODE=false
ROLLBACK_LIST=false
ROLLBACK_REF="previous"
LAST_SNAPSHOT_TS=""
LOCAL_GIT_SHA="$(git -C "$LOCAL_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')"

usage() {
  cat <<'EOF'
GBrainKG production deploy / multi-instance ops (local -> PROD_HOST, default meetings2)

Usage:
  bash scripts/deploy-prod.sh [deploy options]
  bash scripts/deploy-prod.sh --rollback [previous|<timestamp>] [target]
  bash scripts/deploy-prod.sh --rollback=list [target]

Deploy options:
  --target=all|instN   Which instance(s) to publish (default: all)
  --skip-build         Reuse existing local dist/.next (skip pnpm build)
  --skip-gate          Skip the release gate (GATE_STRICT=1 scripts/ci.sh). Warns.
  -h, --help           Show this help

Rollback options:
  --rollback [ref]     Restore a pre-release snapshot, restart, health-check.
                       ref: 'previous' (default) | 'latest' | <timestamp>
  --rollback=list      List available snapshot timestamps for the target
                       (alias: scripts/rollback-release.sh --list)

Release gate (default ON):
  GATE_STRICT=1 bash scripts/ci.sh must pass before any rsync. On gate failure
  the deploy aborts. --skip-gate bypasses it (explicit, warned).

Pre-release snapshot (always, before rsync):
  $PROD_REPO/.releases/<timestamp>/manifest.json
    - remote/local git SHA, sha256(.env), apps/api/package.json version
    - tree.tar.gz sha256 (tree digest taken before this release's rsync)
  $PROD_REPO/.releases/<timestamp>/tree.tar.gz
    - restorable code + build-artifact tree (no node_modules/.env/.git)

Isolation prechecks (kept): /data mount, DATA_DIR, PROD_REPO, ENV_FILE,
REDIS_DB match, BYPASSRLS grant, HNSW ef_search/iterative_scan warnings.

Health-check failure does NOT auto-rollback; it prints the exact rollback
command and exits non-zero.

Examples:
  bash scripts/deploy-prod.sh --target=inst1
  bash scripts/deploy-prod.sh --target=all --skip-build
  bash scripts/deploy-prod.sh --rollback previous --target=inst1
  bash scripts/rollback-release.sh 20260922120000 --target=inst2
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-gate)
      SKIP_GATE=true
      shift
      ;;
    --rollback)
      ROLLBACK_MODE=true
      shift
      if [[ $# -gt 0 ]]; then
        case "$1" in
          previous|latest) ROLLBACK_REF="$1"; shift ;;
          [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*) ROLLBACK_REF="$1"; shift ;;
        esac
      fi
      ;;
    --rollback=*)
      ROLLBACK_MODE=true
      ROLLBACK_REF="${1#*=}"
      if [[ "$ROLLBACK_REF" == "list" ]]; then
        ROLLBACK_LIST=true
        ROLLBACK_REF="previous"
      fi
      shift
      ;;
    --target=*)
      TARGET="${1#*=}"
      shift
      ;;
    inst*|--inst*)
      TARGET="${1#--}"
      shift
      ;;
    all|--all)
      TARGET="all"
      shift
      ;;
    previous|latest)
      # bare rollback ref (e.g. via scripts/rollback-release.sh)
      ROLLBACK_MODE=true
      ROLLBACK_REF="$1"
      shift
      ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*)
      # 8+ digit snapshot timestamp (YYYYMMDDHHMMSS); avoids eating bare inst nums
      ROLLBACK_MODE=true
      ROLLBACK_REF="$1"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

log() { echo "[deploy-prod $(date '+%F %T')] $*"; }

# ---- 0. 发布门禁 (release gate) ----
run_release_gate() {
  if [[ "$SKIP_GATE" == true ]]; then
    log "WARNING: --skip-gate specified: SKIPPING release gate (GATE_STRICT=1 bash scripts/ci.sh)."
    log "WARNING: Production deploy proceeds WITHOUT automated test verification."
    return 0
  fi
  log "[gate] Running release gate: GATE_STRICT=1 bash scripts/ci.sh ..."
  if ! (cd "$LOCAL_ROOT" && GATE_STRICT=1 bash scripts/ci.sh); then
    log "ERROR: Release gate FAILED. Aborting production deploy (no rsync, no restart)."
    log "       Fix the failing layers, or re-run with --skip-gate to bypass (not recommended)."
    exit 1
  fi
  log "[gate] Release gate PASSED."
}

# ---- 0b. 实例参数解析函数 ----
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
    # Snapshots live on the data disk: root is only 20G and filled up when
    # .releases stayed under $PROD_REPO on /. Symlink keeps $PROD_REPO/.releases
    # working for rollback/list.
    RELEASES_DIR="/data/llmwiki/.releases"
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
    RELEASES_DIR="/data/llmwiki-inst${INST_NUM}/code/.releases"
    ENV_FILE="/home/ubuntu/.config/llmwiki/production-inst${INST_NUM}.env"
    EXPECTED_REDIS_DB=$offset
    DB_NAME="llmwiki_inst${INST_NUM}"
  else
    log "ERROR: Invalid instance target '$inst'. Choose 'instN' (e.g. inst1, inst2) or 'all'."
    exit 1
  fi
}

discover_instances() {
  INSTANCES=()
  if ssh "$PROD_HOST" "[[ -f /home/ubuntu/.config/llmwiki/production.env ]]"; then
    INSTANCES+=("inst1")
  fi
  local remote_nums
  remote_nums=$(ssh "$PROD_HOST" "ls /home/ubuntu/.config/llmwiki/production-inst*.env 2>/dev/null" | grep -oE 'inst[0-9]+' | sort -u -V || true)
  local inst
  for inst in $remote_nums; do
    INSTANCES+=("$inst")
  done
}

# ---- 0c. 发布前快照（回滚点） ----
# 在 rsync 前把 $PROD_REPO 当前状态写入 .releases/<ts>/：
#   manifest.json : remote git SHA (`git rev-parse HEAD`)、local git SHA、
#                   sha256(.env)、apps/api/package.json version、
#                   tree.tar.gz 摘要（即「rsync --delete 前的树摘要」）
#   tree.tar.gz   : 可用于非 git 恢复的完整可部署树
take_pre_release_snapshot() {
  local ts="$1"
  # Prefer the data-disk releases dir (set by resolve_instance_params). The
  # $PROD_REPO/.releases path is kept as a symlink so rollback/list keep working.
  local releases_dir="${RELEASES_DIR:-$PROD_REPO/.releases}"
  log "[$INST_NAME] Pre-release snapshot -> $releases_dir/$ts ..."
  ssh "$PROD_HOST" "
    set -euo pipefail
    RELEASES_ROOT='$releases_dir'
    REL_DIR='$releases_dir/$ts'
    if ! mkdir -p \"\$RELEASES_ROOT\" 2>/dev/null; then
      echo \"  ! cannot create \$RELEASES_ROOT, falling back to $PROD_REPO/.releases\"
      RELEASES_ROOT='$PROD_REPO/.releases'
      REL_DIR=\"\$RELEASES_ROOT/$ts\"
      mkdir -p \"\$REL_DIR\"
    fi
    # Only manage a symlink when the data-disk dir differs from $PROD_REPO/.releases.
    # Never ln a path onto itself (that creates a self-referential loop).
    if [[ \"\$RELEASES_ROOT\" != '$PROD_REPO/.releases' ]]; then
      if [[ -L '$PROD_REPO/.releases' ]]; then
        # Repair a pre-existing self-loop or stale link.
        ln -sfn \"\$RELEASES_ROOT\" '$PROD_REPO/.releases'
      elif [[ ! -e '$PROD_REPO/.releases' ]]; then
        ln -sfn \"\$RELEASES_ROOT\" '$PROD_REPO/.releases'
      elif [[ -d '$PROD_REPO/.releases' ]]; then
        # Legacy on-disk dir: move it to the data disk so / never fills again.
        cp -a '$PROD_REPO/.releases/.' \"\$RELEASES_ROOT/\" 2>/dev/null || true
        rm -rf '$PROD_REPO/.releases'
        ln -sfn \"\$RELEASES_ROOT\" '$PROD_REPO/.releases'
      fi
    fi
    mkdir -p \"\$REL_DIR\"

    remote_git_sha=\$(git -C '$PROD_REPO' rev-parse HEAD 2>/dev/null || echo 'unknown')
    env_sha=\$(sha256sum '$ENV_FILE' | awk '{print \$1}')
    api_version=\$(node -e \"try{console.log(require('$PROD_REPO/apps/api/package.json').version)}catch(e){console.log('unknown')}\" 2>/dev/null || echo 'unknown')

    # Tree digest + restorable archive, taken BEFORE this release's rsync.
    # Mirrors deploy rsync excludes; also drops caches/venvs and any .env*.
    (cd '$PROD_REPO' && find . \\
      \\( -name node_modules -o -name .git -o -name .releases -o -name .venv \\
         -o -name __pycache__ -o -name .turbo -o -name .pytest_cache \\
         -o -name .secrets -o -name .agents -o -name .playwright-mcp \\
         -o -name runtime -o -name scratch -o -name screenshots \\
         -o -name docs -o -name design \\) -prune -o \\
      \\( -name cache -path '*/.next/cache' \\) -prune -o \\
      -type f ! -name '.env' ! -name '.env.*' ! -name '*.log' \\
      -print | sort | tar -czf \"\$REL_DIR/tree.tar.gz\" -T -)
    tree_sha=\$(sha256sum \"\$REL_DIR/tree.tar.gz\" | awk '{print \$1}')

    cat > \"\$REL_DIR/manifest.json\" <<JSON
{
  \"timestamp\": \"$ts\",
  \"instance\": \"$INST_NAME\",
  \"prod_repo\": \"$PROD_REPO\",
  \"env_file\": \"$ENV_FILE\",
  \"env_sha256\": \"\$env_sha\",
  \"remote_git_sha\": \"\$remote_git_sha\",
  \"local_git_sha\": \"$LOCAL_GIT_SHA\",
  \"api_version\": \"\$api_version\",
  \"tree_sha256\": \"\$tree_sha\",
  \"api_service\": \"$API_SERVICE\",
  \"web_service\": \"$WEB_SERVICE\",
  \"api_port\": $API_PORT,
  \"web_port\": $WEB_PORT,
  \"public_port\": $PUBLIC_PORT,
  \"db_name\": \"$DB_NAME\",
  \"expected_redis_db\": $EXPECTED_REDIS_DB,
  \"created_at\": \"\$(date -u +%FT%TZ)\"
}
JSON
    echo \"  - manifest: git=\$remote_git_sha api=\$api_version env=\${env_sha:0:12}… tree=\${tree_sha:0:12}…\"

    # Keep only the newest 5 snapshots so root/data disks cannot fill up.
    KEEP=5
    mapfile -t snap_dirs < <(ls -1 \"\$RELEASES_ROOT\" 2>/dev/null | grep -E '^[0-9]{8,14}\$' | sort || true)
    if (( \${#snap_dirs[@]} > KEEP )); then
      for old in \"\${snap_dirs[@]:0:\${#snap_dirs[@]}-KEEP}\"; do
        echo \"  - pruning old snapshot \$old\"
        rm -rf \"\$RELEASES_ROOT/\$old\"
      done
    fi
  "
  LAST_SNAPSHOT_TS="$ts"
}

print_rollback_hint() {
  local ts="${LAST_SNAPSHOT_TS:-previous}"
  log "  To roll back this release, run ONE of:"
  log "    bash scripts/rollback-release.sh ${ts} --target=$INST_NAME"
  log "    bash scripts/deploy-prod.sh --rollback ${ts} --target=$INST_NAME"
  log "  (Auto-rollback is intentionally NOT performed to avoid unintended damage.)"
}

# ---- 0d. 快照列表 / 回滚 ----
list_release_snapshots() {
  resolve_instance_params "$1"
  log "[$INST_NAME] Snapshots under $PROD_REPO/.releases :"
  ssh "$PROD_HOST" "
    if [[ ! -d '$PROD_REPO/.releases' ]]; then
      echo '  (none — no pre-release snapshots recorded yet)'
      exit 0
    fi
    for d in \$(ls -1 '$PROD_REPO/.releases' | grep -E '^[0-9]{8,14}\$' | sort); do
      api=\$(node -e \"try{console.log(require('$PROD_REPO/.releases/'+'\$d'+'/manifest.json').api_version)}catch(e){console.log('?')}\" 2>/dev/null || echo '?')
      git_sha=\$(node -e \"try{console.log((require('$PROD_REPO/.releases/'+'\$d'+'/manifest.json').remote_git_sha||'').slice(0,12))}catch(e){console.log('?')}\" 2>/dev/null || echo '?')
      echo \"  \$d  api=\$api  git=\$git_sha\"
    done
  "
}

resolve_rollback_ts() {
  # sets ROLLBACK_TS for current PROD_REPO
  local ref="$1"
  if [[ "$ref" == "previous" || "$ref" == "latest" ]]; then
    ROLLBACK_TS=$(ssh "$PROD_HOST" "ls -1 '$PROD_REPO/.releases' 2>/dev/null | grep -E '^[0-9]{8,14}\$' | sort | tail -1" || true)
    if [[ -z "$ROLLBACK_TS" ]]; then
      log "ERROR: [$INST_NAME] no snapshots under $PROD_REPO/.releases — cannot resolve '$ref'."
      log "       Snapshots are created automatically by deploy-prod.sh before each rsync."
      return 1
    fi
  else
    ROLLBACK_TS="$ref"
    if ! ssh "$PROD_HOST" "[[ -f '$PROD_REPO/.releases/$ROLLBACK_TS/manifest.json' ]]"; then
      log "ERROR: [$INST_NAME] snapshot '$ROLLBACK_TS' not found under $PROD_REPO/.releases/"
      return 1
    fi
  fi
  return 0
}

rollback_single_instance() {
  local target_inst="$1"
  resolve_instance_params "$target_inst"

  if ! resolve_rollback_ts "$ROLLBACK_REF"; then
    return 1
  fi

  log ">>> Rolling back $INST_NAME to snapshot $ROLLBACK_TS ($API_SERVICE, $WEB_SERVICE, port $PUBLIC_PORT) <<<"

  local rc=0
  ssh "$PROD_HOST" "
    set -euo pipefail
    export PATH=\$HOME/.local/bin:\$HOME/.hermes/node/bin:/usr/local/bin:\$PATH
    REL_DIR='$PROD_REPO/.releases/$ROLLBACK_TS'
    [[ -f \"\$REL_DIR/manifest.json\" ]] || { echo 'ERROR: manifest.json missing'; exit 1; }

    remote_git_sha=\$(node -e \"try{console.log(require('\$REL_DIR/manifest.json').remote_git_sha||'')}catch(e){console.log('')}\")
    restored_via='tree.tar.gz'

    if [[ -n \"\$remote_git_sha\" && \"\$remote_git_sha\" != 'unknown' && -d '$PROD_REPO/.git' ]] \\
       && git -C '$PROD_REPO' cat-file -e \"\$remote_git_sha^{commit}\" 2>/dev/null; then
      echo \"  - Restoring via git checkout \$remote_git_sha\"
      git -C '$PROD_REPO' checkout -f \"\$remote_git_sha\"
      restored_via=\"git:\$remote_git_sha\"
    else
      [[ -f \"\$REL_DIR/tree.tar.gz\" ]] || { echo 'ERROR: tree.tar.gz missing and git SHA unusable'; exit 1; }
      echo '  - Restoring via tree.tar.gz snapshot'
      tmpdir=\$(mktemp -d)
      trap 'rm -rf \"\$tmpdir\"' EXIT
      tar -xzf \"\$REL_DIR/tree.tar.gz\" -C \"\$tmpdir\"
      # --delete so files added by the bad release are removed (excludes protect
      # node_modules / .env* / runtime / .releases, same as deploy rsync).
      rsync -a --delete \\
        --exclude='.git' --exclude='node_modules' --exclude='.next/cache' \\
        --exclude='.env*' --exclude='runtime' --exclude='scratch' \\
        --exclude='screenshots' --exclude='.playwright-mcp' --exclude='.turbo' \\
        --exclude='.pytest_cache' --exclude='.secrets' --exclude='.agents' \\
        --exclude='docs' --exclude='design' --exclude='.releases' \\
        --exclude='.venv' --exclude='__pycache__' \\
        \"\$tmpdir/\" '$PROD_REPO/'
    fi

    echo '  - Reinstalling lockfile-frozen dependencies...'
    cd '$PROD_REPO'
    pnpm install --frozen-lockfile | tail -2
    cd '$PROD_REPO/packages/database'
    set -a
    source '$ENV_FILE'
    set +a
    npx prisma generate

    echo '  - Restarting $API_SERVICE + $WEB_SERVICE ...'
    sudo systemctl restart '$API_SERVICE' '$WEB_SERVICE'
    sleep 3
    systemctl is-active '$API_SERVICE' '$WEB_SERVICE'

    echo '  - Health check...'
    ok=1
    curl -sf 'http://127.0.0.1:$API_PORT/open-api/spec.json' >/dev/null && echo '    - API (port $API_PORT): OK' || { echo '    - API (port $API_PORT): FAIL'; ok=0; }
    curl -sf 'http://127.0.0.1:$WEB_PORT/' >/dev/null && echo '    - Web (port $WEB_PORT): OK' || { echo '    - Web (port $WEB_PORT): FAIL'; ok=0; }
    if [[ \"\$ok\" -ne 1 ]]; then
      echo 'ROLLBACK HEALTH CHECK FAILED (restored_via='\$restored_via')'
      exit 1
    fi
    echo \"  - Rollback complete (restored_via=\$restored_via, snapshot=$ROLLBACK_TS).\"
  " || rc=1

  if [[ "$rc" -ne 0 ]]; then
    log "ERROR: [$INST_NAME] rollback to $ROLLBACK_TS FAILED (non-zero)."
    log "       Inspect: ssh $PROD_HOST \"journalctl -u $API_SERVICE -u $WEB_SERVICE -n 50 --no-pager\""
    return 1
  fi
  log "[$INST_NAME] Rollback to $ROLLBACK_TS succeeded."
  return 0
}

# ---- 1. 本地全量构建与校验 ----
build_local_artifacts() {
  if [[ "$SKIP_BUILD" == false ]]; then
    log "[1/5] Building api + web locally with turbo..."
    (cd "$LOCAL_ROOT" && pnpm build)
  else
    log "[1/5] Skip build (--skip-build), expecting existing dist/.next"
  fi
  [[ -f "$LOCAL_ROOT/apps/api/dist/main.js" ]] || { log "ERROR: apps/api/dist/main.js missing"; exit 1; }
  [[ -d "$LOCAL_ROOT/apps/web/.next" ]] || { log "ERROR: apps/web/.next missing"; exit 1; }
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

  # 3.1b 发布前快照（回滚点）：git SHA / .env 哈希 / api 版本 / rsync 前树摘要
  SNAPSHOT_TS="$(date -u +%Y%m%d%H%M%S)"
  take_pre_release_snapshot "$SNAPSHOT_TS"

  # 3.2 Rsync 代码与构建产物
  log "[$INST_NAME] Synchronizing code + dist..."
  rsync -az --info=stats1 \
    --exclude='.git' --exclude='node_modules' --exclude='.next/cache' \
    --exclude='.env*' --exclude='runtime' --exclude='scratch' \
    --exclude='screenshots' --exclude='.playwright-mcp' --exclude='.turbo' \
    --exclude='.pytest_cache' --exclude='.secrets' --exclude='.agents' \
    --exclude='docs' --exclude='design' --exclude='.releases' --exclude='.venv' \
    "$LOCAL_ROOT/" "$PROD_HOST:$PROD_REPO/"

  # 3.2b 共享 parser-worker 的代码只存在于 inst1 的发布目录
  # (/home/ubuntu/gbrainkg/apps/parser-worker + 同目录 .venv)。只发布 inst2+ 时，
  # 共享 parser 会继续跑旧代码，形成"parser 版本漂移"。这里把 parser 源码同步到
  # inst1 目录，下面 3.4 统一重启，使任何实例的发布都把共享解析服务带到同一版本。
  if [[ "$INST_NAME" != "inst1" ]]; then
    log "[$INST_NAME] Syncing shared parser-worker sources to inst1 release dir..."
    rsync -az --delete \
      --exclude='__pycache__' --exclude='.pytest_cache' --exclude='tests' \
      "$LOCAL_ROOT/apps/parser-worker/" \
      "$PROD_HOST:/home/ubuntu/gbrainkg/apps/parser-worker/"
  fi

  # 3.3 依赖安装、Prisma 迁移与 GBrain 迁移
  log "[$INST_NAME] Running database migrations & pnpm install..."
  ssh "$PROD_HOST" "
    set -e
    export PATH=\$HOME/.local/bin:\$HOME/.hermes/node/bin:/usr/local/bin:\$PATH
    cd '$PROD_REPO'
    # --frozen-lockfile: 生产依赖必须与仓库锁文件逐字一致，禁止发布过程中静默
    # 漂移到更新的传递依赖版本。若此处失败，请先在本地提交更新后的 pnpm-lock.yaml。
    pnpm install --frozen-lockfile | tail -2
    cd '$PROD_REPO/packages/database'
    set -a
    source '$ENV_FILE'
    set +a
    npx prisma generate
    npx prisma migrate deploy
    # Reconcile the NOBYPASSRLS runtime role before restarting the API.
    bash \"$PROD_REPO/scripts/reconcile-runtime-db-role.sh\" '$ENV_FILE'

    # 执行 GBrain 底座迁移，确保 pages / content_chunks 架构同步
    gbrain apply-migrations --yes || true

    # 自动初始化基础角色与超级管理员账号。
    # 绝不使用可猜测的默认口令：未显式提供 ADMIN_INITIAL_PASSWORD 时跳过管理员
    # 初始化（账号已存在的常规发布场景本就不需要它），而不是创建 123456 管理员。
    if [[ -n \"\${ADMIN_INITIAL_PASSWORD:-}\" ]]; then
      ADMIN_INITIAL_PASSWORD=\"\$ADMIN_INITIAL_PASSWORD\" LLMWIKI_FORCE_MIGRATOR_URL=1 RLS_ENFORCE=0 node \"$PROD_REPO/apps/api/dist/bootstrap/production-bootstrap.js\"
    else
      echo '  - ADMIN_INITIAL_PASSWORD not provided: skipping admin password bootstrap (existing admins are untouched).'
    fi

    # 过滤 HNSW 召回参数预检：迁移 20260920120000 会按库写入，但历史库或权限不足
    # 的情况必须显式暴露，否则检索会在 ef_search=40 下静默欠召回（Recall@10 0.21）。
    # pg_db_role_setting.setconfig is a text[] of 'name=value' entries; unnest
    # yields one column (the earlier two-column alias form is a SQL error).
    hnsw_lines=\$(sudo -u postgres psql -d '$DB_NAME' -tAc \"SELECT setting FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) AS setting WHERE d.datname = '$DB_NAME' AND setting LIKE 'hnsw.%' ORDER BY 1\" 2>/dev/null || true)
    echo \"\$hnsw_lines\" | grep -q 'hnsw.ef_search=200' || {
      echo '  ! WARNING: hnsw.ef_search is not 200 for database $DB_NAME'
      echo '    Fix: sudo -u postgres psql -c \"ALTER DATABASE $DB_NAME SET hnsw.ef_search = 200;\"'
      echo '         sudo -u postgres psql -c \"ALTER DATABASE $DB_NAME SET hnsw.iterative_scan = '\''relaxed_order'\'';\"'
    }
    echo \"\$hnsw_lines\" | grep -q 'hnsw.iterative_scan=relaxed_order' || {
      echo '  ! WARNING: hnsw.iterative_scan is not relaxed_order for database $DB_NAME (filtered ANN recall will degrade)'
    }
  "

  # 3.4 重启专属系统服务
  #
  # parser-worker 是所有实例共享的单一服务，但代码与它自己的 venv 都来自 inst1
  # 的发布目录。以前只有 inst1 发布时才重启它，导致「只发 inst2+」时 parser 代码
  # 版本与主仓库漂移；现在任何实例发布都会重启共享 parser（幂等）。
  log "[$INST_NAME] Restarting $API_SERVICE and $WEB_SERVICE..."
  ssh "$PROD_HOST" "
    sudo systemctl restart '$API_SERVICE' '$WEB_SERVICE'
    if systemctl list-units --type=service --all 2>/dev/null | grep -q 'llmwiki-parser'; then
      echo 'Restarting shared llmwiki-parser service (shared by all instances)...'
      sudo systemctl restart llmwiki-parser
      systemctl is-active llmwiki-parser
    fi
    sleep 3
    systemctl is-active '$API_SERVICE' '$WEB_SERVICE'
  "

  # 3.5 健康巡检与 GBrain 状态校验
  # 失败时不自动回滚（避免误伤），只打印可直接执行的回滚命令并以非零退出。
  # Nest 冷启动可达 10s+，固定 sleep 3 后单次 curl 会把未就绪误判为故障。
  log "[$INST_NAME] Verifying health..."
  local health_rc=0
  ssh "$PROD_HOST" "
    ok=1
    api_ok=0
    web_ok=0
    for i in \$(seq 1 30); do
      curl -sf 'http://127.0.0.1:$API_PORT/open-api/spec.json' >/dev/null && api_ok=1
      curl -sf 'http://127.0.0.1:$WEB_PORT/' >/dev/null && web_ok=1
      if [[ \"\$api_ok\" -eq 1 && \"\$web_ok\" -eq 1 ]]; then
        break
      fi
      sleep 2
    done
    if [[ \"\$api_ok\" -eq 1 ]]; then echo '  - API (port $API_PORT): OK'; else echo '  - API (port $API_PORT): FAIL'; ok=0; fi
    if [[ \"\$web_ok\" -eq 1 ]]; then echo '  - Web (port $WEB_PORT): OK'; else echo '  - Web (port $WEB_PORT): FAIL'; ok=0; fi
    domain=\$(grep -E '^WEB_ORIGIN=' '$ENV_FILE' | head -1 | sed -E 's|^WEB_ORIGIN=https?://([^:/]+).*|\1|' || echo '127.0.0.1')
    scheme=\$(grep -E '^WEB_ORIGIN=' '$ENV_FILE' | head -1 | grep -q '^WEB_ORIGIN=https://' && echo 'https' || echo 'http')
    curl -sk --resolve \"\$domain:$PUBLIC_PORT:127.0.0.1\" -o /dev/null -w \"  - Public Gateway (\$PUBLIC_PORT): HTTP %{http_code}\n\" \"\$scheme://\$domain:$PUBLIC_PORT/\" || echo \"  - Public Gateway (\$PUBLIC_PORT): skipped\"
    set -a
    source '$ENV_FILE'
    set +a
    gbrain sources status --json >/dev/null && echo '  - GBrain engine status: OK' || { echo '  - GBrain engine status: FAIL'; ok=0; }
    exit \$((1 - ok))
  " || health_rc=1

  if [[ "$health_rc" -ne 0 ]]; then
    log "ERROR: [$INST_NAME] post-deploy health check FAILED."
    print_rollback_hint
    exit 1
  fi
  log "[$INST_NAME] Successfully deployed!"
}

# ---- 4. 执行发布计划 ----
if [[ "$ROLLBACK_MODE" == true ]]; then
  # 回滚是应急路径：不跑门禁、不要求本地构建产物。
  if [[ "$ROLLBACK_LIST" == true ]]; then
    if [[ "$TARGET" == "all" ]]; then
      discover_instances
      for inst in "${INSTANCES[@]}"; do
        list_release_snapshots "$inst"
      done
    else
      list_release_snapshots "$TARGET"
    fi
    exit 0
  fi

  log "ROLLBACK MODE: ref='$ROLLBACK_REF' target='$TARGET' host='$PROD_HOST'"
  ROLLBACK_FAILED=0
  if [[ "$TARGET" == "all" ]]; then
    discover_instances
    log "Discovered instance(s): ${INSTANCES[*]:-none}"
    if [[ ${#INSTANCES[@]} -eq 0 ]]; then
      log "ERROR: no instances discovered to roll back."
      exit 1
    fi
    for inst in "${INSTANCES[@]}"; do
      echo ""
      rollback_single_instance "$inst" || ROLLBACK_FAILED=1
    done
  else
    rollback_single_instance "$TARGET" || ROLLBACK_FAILED=1
  fi

  if [[ "$ROLLBACK_FAILED" -ne 0 ]]; then
    log "ROLLBACK FAILED (one or more instances)."
    exit 1
  fi
  log "ROLLBACK COMPLETE."
  exit 0
fi

# 发布路径：门禁 -> 构建 -> 逐实例（预检/快照/rsync/迁移/重启/健康）
run_release_gate
build_local_artifacts

if [[ "$TARGET" == "all" ]]; then
  log "Discovering all configured instances on $PROD_HOST..."
  discover_instances

  log "Found active instance(s): ${INSTANCES[*]:-none}"
  if [[ ${#INSTANCES[@]} -eq 0 ]]; then
    log "ERROR: no instances discovered on $PROD_HOST."
    exit 1
  fi
  for inst in "${INSTANCES[@]}"; do
    echo ""
    deploy_single_instance "$inst"
  done
  log "All discovered instances (${INSTANCES[*]}) deployed successfully!"
else
  deploy_single_instance "$TARGET"
fi
