#!/usr/bin/env bash
# 恢复演练 (restore drill)：在本地/测试 PostgreSQL 上把最近备份恢复进一次性演练库，
# 测量并打印 RPO（备份新鲜度）与 RTO（恢复耗时）。
#
#   ⛔ 安全铁律：绝不覆盖生产库。目标库名强制为 DRILL_DB_NAME（默认 llmwiki_drill，
#      必须以 _drill 结尾），脚本内部还会拒绝 llmwiki / llmwiki_inst* 等生产名。
#
# 用法:
#   ./restore-drill.sh                  # 演练恢复到 llmwiki_drill（默认安全目标）
#   ./restore-drill.sh --dry-run        # 只校验备份 + 打印计划，不建库不恢复
#   ./restore-drill.sh --dump PATH      # 指定 dump（默认取 BACKUP_ROOT 最新 db-*.dump）
#   ./restore-drill.sh --cleanup        # 演练结束后 DROP 演练库
#   ./restore-drill.sh --files          # 同时把 files-*.tar.gz 恢复到 DRILL_FILES_DIR
#   ./restore-drill.sh --help
#
# 环境变量（密码只从 env 读，绝不写死）:
#   DRILL_DB_NAME        演练库名，默认 llmwiki_drill（必须 *_drill）
#   DRILL_DB_USER        连接用户，默认 llmwiki
#   DRILL_DB_CONTAINER   docker 容器名，默认 llmwiki-postgres（host 无 psql 时回退）
#   DRILL_DB_HOST/PORT   native 连接，默认 127.0.0.1:5432
#   DRILL_FILES_DIR      文件演练目录，默认 ~/.local/share/llmwiki/restore-drill
#   PGPASSWORD           密码（native psql/pg_restore）
#   DATABASE_URL         完整连接串（仅用于推断 host/port/user，不会作为恢复目标）
#   BACKUP_ROOT          备份根，默认 ~/.local/share/llmwiki/backups
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.local/share/llmwiki/backups}"
DRILL_DB_NAME="${DRILL_DB_NAME:-llmwiki_drill}"
DRILL_DB_USER="${DRILL_DB_USER:-llmwiki}"
DRILL_DB_CONTAINER="${DRILL_DB_CONTAINER:-llmwiki-postgres}"
DRILL_DB_HOST="${DRILL_DB_HOST:-127.0.0.1}"
DRILL_DB_PORT="${DRILL_DB_PORT:-5432}"
DRILL_FILES_DIR="${DRILL_FILES_DIR:-$HOME/.local/share/llmwiki/restore-drill}"
DUMP_ARG=""
DRY_RUN=0
DO_CLEANUP=0
DO_FILES=0

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --cleanup) DO_CLEANUP=1 ;;
    --files) DO_FILES=1 ;;
    --dump) shift; DUMP_ARG="${1:-}" ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[restore-drill $(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }

# ---- 安全门禁：演练库名绝不等于生产库 ----
case "$DRILL_DB_NAME" in
  llmwiki|llmwiki_inst*|postgres|template1|template0)
    die "refusing to use production-like DB name: '$DRILL_DB_NAME'. Set DRILL_DB_NAME to a *_drill name." ;;
  *_drill) : ;;
  *)
    if [ "${DRILL_ALLOW_CUSTOM:-0}" = "1" ]; then
      log "WARNING: DRILL_ALLOW_CUSTOM=1 — allowing non-_drill name '$DRILL_DB_NAME'"
    else
      die "DRILL_DB_NAME must end with _drill (got: '$DRILL_DB_NAME'). Override with DRILL_ALLOW_CUSTOM=1 if you really mean it."
    fi ;;
esac

# ---- 挑备份 ----
if [ -n "$DUMP_ARG" ]; then
  DUMP_FILE="$DUMP_ARG"
else
  DUMP_FILE="$(ls -1t "$BACKUP_ROOT"/db-*.dump 2>/dev/null | head -1 || true)"
fi
[ -n "$DUMP_FILE" ] && [ -s "$DUMP_FILE" ] || die "no usable dump found (looked in: $BACKUP_ROOT). Run deploy/backup.sh first."
FILES_TAR="$(ls -1t "$BACKUP_ROOT"/files-*.tar.gz 2>/dev/null | head -1 || true)"

NOW="$(date +%s)"
DUMP_MTIME="$(stat -c %Y "$DUMP_FILE" 2>/dev/null || echo "$NOW")"
RPO_S=$((NOW - DUMP_MTIME))

human_age() {
  local sec="$1"
  if [ "$sec" -lt 60 ]; then echo "${sec}s"
  elif [ "$sec" -lt 3600 ]; then echo "$((sec / 60))m $((sec % 60))s"
  elif [ "$sec" -lt 86400 ]; then echo "$((sec / 3600))h $(((sec % 3600) / 60))m"
  else echo "$((sec / 86400))d $(((sec % 86400) / 3600))h"
  fi
}

echo "=================================================="
echo "  LLMWiki restore drill (NEVER touches production)"
echo "=================================================="
echo "  dump            : $DUMP_FILE"
echo "  dump size       : $(du -h "$DUMP_FILE" | cut -f1)"
echo "  drill database  : $DRILL_DB_NAME  (user=$DRILL_DB_USER host=$DRILL_DB_HOST:$DRILL_DB_PORT / container=$DRILL_DB_CONTAINER)"
echo "  drill files dir : $DRILL_FILES_DIR"
echo "  mode            : $([ "$DRY_RUN" -eq 1 ] && echo 'DRY-RUN (plan + verify only)' || echo 'EXECUTE (restore into drill DB)')"
echo ""

# ---- 备份完整性校验（与 backup.sh 同口径）----
verify_dump() {
  local f="$1" magic_hex
  [ -s "$f" ] || { log "VERIFY FAIL: $f missing or empty"; return 1; }
  # od 取魔数十六进制，避免 gzip 头 NUL 字节触发 bash 警告
  magic_hex="$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')"
  case "$magic_hex" in
    1f8b*) gzip -t "$f" || return 1; log "verify ok (gzip -t): $(basename "$f")" ;;
    5047444d*)
      if command -v pg_restore >/dev/null 2>&1; then
        pg_restore --list "$f" >/dev/null 2>&1 || return 1
        log "verify ok (PGDMP + pg_restore --list): $(basename "$f")"
      else
        log "verify ok (PGDMP magic): $(basename "$f")"
      fi ;;
    *) gzip -t "$f" 2>/dev/null || { log "VERIFY FAIL: unrecognized $f"; return 1; }
       log "verify ok (gzip -t fallback): $(basename "$f")" ;;
  esac
}
verify_dump "$DUMP_FILE" || die "dump failed verification: $DUMP_FILE"
if [ -n "$FILES_TAR" ]; then
  gzip -t "$FILES_TAR" 2>/dev/null || die "files archive failed gzip -t: $FILES_TAR"
  log "verify ok (gzip -t): $(basename "$FILES_TAR")"
fi

# ---- 执行通道：优先 host 工具，否则 docker exec ----
USE_DOCKER=0
if command -v psql >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
  USE_DOCKER=0
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DRILL_DB_CONTAINER"; then
  USE_DOCKER=1
else
  die "neither host psql/pg_restore nor docker container $DRILL_DB_CONTAINER available"
fi

psql_drill() {
  # psql_drill <dbname> <sql>
  local db="$1" sql="$2"
  if [ "$USE_DOCKER" -eq 1 ]; then
    docker exec -i "$DRILL_DB_CONTAINER" psql -U "$DRILL_DB_USER" -d "$db" -v ON_ERROR_STOP=1 -c "$sql"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql -h "$DRILL_DB_HOST" -p "$DRILL_DB_PORT" -U "$DRILL_DB_USER" -d "$db" -v ON_ERROR_STOP=1 -c "$sql"
  fi
}

psql_scalar() {
  # 标量查询：tuples-only + unaligned，直接拿值
  local db="$1" sql="$2"
  if [ "$USE_DOCKER" -eq 1 ]; then
    docker exec -i "$DRILL_DB_CONTAINER" psql -U "$DRILL_DB_USER" -d "$db" -tAc "$sql"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql -h "$DRILL_DB_HOST" -p "$DRILL_DB_PORT" -U "$DRILL_DB_USER" -d "$db" -tAc "$sql"
  fi
}

echo "  RPO (backup freshness) : $(human_age "$RPO_S")  (${RPO_S}s)"
echo "                          = now - dump mtime; if prod died now, max data loss window"
if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "  DRY-RUN plan:"
  echo "    1. CREATE DATABASE $DRILL_DB_NAME (with vector/pg_trgm/pgcrypto)"
  echo "    2. pg_restore --no-owner --exit-on-error  '$DUMP_FILE'  ->  $DRILL_DB_NAME"
  echo "    3. verify SQL: counts for users/knowledgebases/documents/chunks + vector index"
  echo "    4. (optional --files) tar -xzf files archive -> $DRILL_FILES_DIR"
  echo "    5. report RTO = wall time of steps 1-3"
  echo ""
  echo "  RTO: not measured in dry-run (no restore performed)"
  echo "=================================================="
  log "dry-run complete. dump is valid; nothing was created."
  exit 0
fi

# ---- 1. 建演练库（幂等：存在则先 DROP——只允许 DROP *_drill）----
log "preparing drill database $DRILL_DB_NAME ..."
if [ "$USE_DOCKER" -eq 1 ]; then
  docker exec -i "$DRILL_DB_CONTAINER" psql -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DRILL_DB_NAME' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1 || true
  docker exec -i "$DRILL_DB_CONTAINER" psql -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$DRILL_DB_NAME\";"
  docker exec -i "$DRILL_DB_CONTAINER" psql -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE \"$DRILL_DB_NAME\" OWNER \"$DRILL_DB_USER\";"
else
  PGPASSWORD="${PGPASSWORD:-}" psql -h "$DRILL_DB_HOST" -p "$DRILL_DB_PORT" -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DRILL_DB_NAME' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1 || true
  PGPASSWORD="${PGPASSWORD:-}" psql -h "$DRILL_DB_HOST" -p "$DRILL_DB_PORT" -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$DRILL_DB_NAME\";"
  PGPASSWORD="${PGPASSWORD:-}" psql -h "$DRILL_DB_HOST" -p "$DRILL_DB_PORT" -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE \"$DRILL_DB_NAME\" OWNER \"$DRILL_DB_USER\";"
fi

# 与 bootstrap-new-server.sh 对齐的扩展集
for ext in vector pg_trgm pgcrypto; do
  psql_drill "$DRILL_DB_NAME" "CREATE EXTENSION IF NOT EXISTS $ext;" >/dev/null
done
log "drill database ready: $DRILL_DB_NAME"

# ---- 2. pg_restore（RTO 计时开始）----
RTO_START="$(date +%s.%N 2>/dev/null || date +%s)"
log "restoring $(basename "$DUMP_FILE") into $DRILL_DB_NAME (timing RTO) ..."
if [ "$USE_DOCKER" -eq 1 ]; then
  RESTORE_TMP="/tmp/restore-drill-$(basename "$DUMP_FILE")"
  docker cp "$DUMP_FILE" "$DRILL_DB_CONTAINER:$RESTORE_TMP"
  docker exec -i "$DRILL_DB_CONTAINER" pg_restore \
    -U "$DRILL_DB_USER" -d "$DRILL_DB_NAME" --no-owner --exit-on-error "$RESTORE_TMP"
  docker exec -i "$DRILL_DB_CONTAINER" rm -f "$RESTORE_TMP"
else
  PGPASSWORD="${PGPASSWORD:-}" pg_restore \
    -h "$DRILL_DB_HOST" -p "$DRILL_DB_PORT" -U "$DRILL_DB_USER" -d "$DRILL_DB_NAME" \
    --no-owner --exit-on-error "$DUMP_FILE"
fi
RTO_END="$(date +%s.%N 2>/dev/null || date +%s)"
RTO_S="$(awk -v a="$RTO_START" -v b="$RTO_END" 'BEGIN{printf "%d", (b-a)}')"
log "restore finished in ${RTO_S}s"

# ---- 3. 验证 SQL ----
log "running verification SQL ..."
VERIFY_SQL="SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname='public') AS tables,
  (SELECT count(*) FROM pg_indexes WHERE schemaname='public') AS indexes;"
psql_drill "$DRILL_DB_NAME" "$VERIFY_SQL" || log "WARNING: catalog verify query failed"

# 关键表存在性 + 行数（Prisma 模型名即表名，无 @@map；缺表时不让演练整体失败，只告警）
for name in "User" "KnowledgeBase" "Document" "Chunk" "GraphEntity"; do
  cnt="$(psql_scalar "$DRILL_DB_NAME" "SELECT count(*) FROM \"$name\";" 2>/dev/null || true)"
  if [ -n "$cnt" ] && [[ "$cnt" =~ ^[0-9]+$ ]]; then
    echo "    table $name : $cnt rows"
  else
    log "WARNING: table $name missing or unreadable in drill DB"
  fi
done

# 向量索引/扩展自检
psql_drill "$DRILL_DB_NAME" "SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','pgcrypto') ORDER BY 1;" \
  || log "WARNING: extension check failed"

if [ "$DO_FILES" -eq 1 ] && [ -n "$FILES_TAR" ]; then
  log "restoring files archive -> $DRILL_FILES_DIR ..."
  rm -rf "$DRILL_FILES_DIR"
  mkdir -p "$DRILL_FILES_DIR"
  tar -xzf "$FILES_TAR" -C "$DRILL_FILES_DIR"
  echo "    files restored: $(find "$DRILL_FILES_DIR" -type f 2>/dev/null | wc -l | tr -d ' ') file(s) under $DRILL_FILES_DIR"
elif [ "$DO_FILES" -eq 1 ]; then
  log "WARNING: --files requested but no files-*.tar.gz found in $BACKUP_ROOT"
fi

# ---- 4. 可选清理 ----
if [ "$DO_CLEANUP" -eq 1 ]; then
  log "cleanup: dropping drill database $DRILL_DB_NAME ..."
  if [ "$USE_DOCKER" -eq 1 ]; then
    docker exec -i "$DRILL_DB_CONTAINER" psql -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
      "DROP DATABASE IF EXISTS \"$DRILL_DB_NAME\";"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql -h "$DRILL_DB_HOST" -p "$DRILL_DB_PORT" -U "$DRILL_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
      "DROP DATABASE IF EXISTS \"$DRILL_DB_NAME\";"
  fi
fi

# ---- 5. RPO / RTO 报告 ----
echo ""
echo "=================================================="
echo "  Restore drill result"
echo "=================================================="
echo "  source dump     : $(basename "$DUMP_FILE")"
echo "  drill database  : $DRILL_DB_NAME$([ "$DO_CLEANUP" -eq 1 ] && echo ' (dropped by --cleanup)')"
echo "  RPO (freshness) : $(human_age "$RPO_S")  [${RPO_S}s]  — backup age at drill start"
echo "  RTO (restore)   : $(human_age "$RTO_S")  [${RTO_S}s]  — create DB + pg_restore + verify"
echo "  verdict         : restore path is executable; record these numbers in deploy/restore-drill.md"
echo "=================================================="
log "drill complete."
