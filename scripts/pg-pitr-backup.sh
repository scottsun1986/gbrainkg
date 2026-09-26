#!/usr/bin/env bash
# PostgreSQL 物理基础备份 (pg_basebackup) — PITR/HA 基线 (ROI-5)
#
# 产物: $BACKUP_ROOT/basebackup-<STAMP>/ (tar 格式可选) + basebackup-manifest.json
# 保留: 最新 N 份 (PITR_BASEBACKUP_KEEP, 默认 3); 被删除的 basebackup 所覆盖的
#       时间段不能再做 PITR —— 详见 docs/postgres-pitr-ha-runbook.md
#
# 用法:
#   ./pg-pitr-backup.sh                  # 流复制 basebackup (+ manifest)
#   ./pg-pitr-backup.sh --format=plain   # 目录格式 (便于直接做恢复源)
#   ./pg-pitr-backup.sh --format=tar     # tar 格式 (默认; 带 gzip 可选 --gzip)
#   ./pg-pitr-backup.sh --label mytag    # 自定义 backup_label 备注
#   ./pg-pitr-backup.sh --slot standby1  # 指定复制槽 (需已存在; 防 WAL 回收)
#   ./pg-pitr-backup.sh --dry-run        # 只打印计划
#   ./pg-pitr-backup.sh --help
#
# 环境变量:
#   PITR_BACKUP_ROOT     备份根, 默认 /data/pg-backup (或 BACKUP_ROOT)
#   PITR_BASEBACKUP_KEEP 保留份数, 默认 3
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE   连接 (默认 127.0.0.1:5432 user=postgres)
#   PITR_DB_CONTAINER    docker 容器名; 宿主无 pg_basebackup 时回退 docker exec
#   PITR_USE_SUDO        =1 时用 sudo -u postgres 执行 (本地 peer 认证)
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${PITR_BACKUP_ROOT:-${BACKUP_ROOT:-/data/pg-backup}}"
KEEP="${PITR_BASEBACKUP_KEEP:-3}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
DB_CONTAINER="${PITR_DB_CONTAINER:-llmwiki-postgres}"
USE_SUDO="${PITR_USE_SUDO:-0}"
FMT="tar"
GZIP=0
LABEL="pitr-$STAMP"
SLOT=""
DRY=0

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --format=*) FMT="${1#--format=}" ;;
    --gzip) GZIP=1 ;;
    --label) shift; LABEL="${1:-$LABEL}" ;;
    --slot) shift; SLOT="${1:-}" ;;
    --dry-run) DRY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
done

case "$FMT" in tar|plain) : ;; *) echo "ERROR: --format must be tar|plain" >&2; exit 2 ;; esac

log() { echo "[pg-pitr-backup $(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }
sha256_of() { sha256sum "$1" | awk '{print $1}'; }
bytes_of() { stat -c%s "$1" 2>/dev/null || wc -c < "$1"; }

TARGET="$BACKUP_ROOT/basebackup-$STAMP"
MANIFEST_LATEST="$BACKUP_ROOT/basebackup-manifest.json"
MANIFEST_STAMPED="$BACKUP_ROOT/basebackup-manifest-$STAMP.json"

echo "=================================================="
echo "  pg_basebackup (PITR baseline)"
echo "=================================================="
echo "  source      : $PGHOST:$PGPORT user=$PGUSER"
echo "  target      : $TARGET  (format=$FMT gzip=$GZIP)"
echo "  label       : $LABEL"
echo "  slot        : ${SLOT:-<none>}"
echo "  retain      : $KEEP basebackup(s) under $BACKUP_ROOT"
echo "  mode        : $([ "$DRY" -eq 1 ] && echo DRY-RUN || echo EXECUTE)"
echo "=================================================="

if [ "$DRY" -eq 1 ]; then
  log "dry-run: would run pg_basebackup -D $TARGET -F${FMT:0:1} -X stream -l $LABEL"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
# peer 通道下 pg_basebackup 以 postgres 运行, 目标目录必须可写
if [ "$USE_SUDO" = "1" ] || [ "$(id -un)" = "root" ]; then
  mkdir -p "$TARGET"
  chown postgres:postgres "$TARGET" "$BACKUP_ROOT" 2>/dev/null || true
  chmod 750 "$TARGET" 2>/dev/null || true
fi

# 执行通道: 宿主 pg_basebackup > sudo -u postgres > docker exec
# 执行通道: 优先 peer (sudo/root → postgres), 否则宿主 pg_basebackup, 否则 docker
run_bb() {
  if [ "$USE_SUDO" = "1" ] || [ "$(id -un)" = "root" ]; then
    # peer 认证: 以 postgres OS 用户走 Unix socket (清掉 PGHOST/PGPASSWORD 避免误走 TCP)
    sudo -n -u postgres env -u PGHOST -u PGPASSWORD pg_basebackup "$@"
  elif command -v pg_basebackup >/dev/null 2>&1; then
    pg_basebackup "$@"
  elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
    die "docker channel needs PITR_TARGET_INSIDE; prefer host pg_basebackup or PITR_USE_SUDO=1"
  else
    die "pg_basebackup not available (install postgresql-client-16 or set PITR_USE_SUDO=1)"
  fi
}

BB_ARGS=(-D "$TARGET" -X stream -l "$LABEL" -v --checkpoint=fast)
case "$FMT" in
  tar) BB_ARGS+=(-Ft) ;;
  plain) BB_ARGS+=(-Fp) ;;
esac
[ "$GZIP" -eq 1 ] && BB_ARGS+=(-Z)
[ -n "$SLOT" ] && BB_ARGS+=(-C -S "$SLOT")
if [ "$USE_SUDO" = "1" ] || [ "$(id -un)" = "root" ]; then
  # peer 认证必须走 Unix socket
  BB_ARGS+=(--username=postgres --host=/var/run/postgresql --port="${PGPORT:-5432}")
else
  BB_ARGS+=(--username="$PGUSER")
fi

log "starting pg_basebackup ..."
START_TS="$(date +%s)"
run_bb "${BB_ARGS[@]}" || die "pg_basebackup failed"
END_TS="$(date +%s)"
DUR=$((END_TS - START_TS))
log "pg_basebackup ok in ${DUR}s -> $TARGET"

# 产物校验
ART=""
if [ "$FMT" = "tar" ]; then
  ART="$TARGET/base.tar"
  [ -s "$ART" ] || die "missing $ART"
  # tar 头非 gzip 时用 tar -t 校验; gzip 时 gzip -t
  if [ "$GZIP" -eq 1 ]; then
    gzip -t "$TARGET/base.tar.gz" 2>/dev/null && ART="$TARGET/base.tar.gz" || true
  fi
  if [ -f "$ART" ]; then
    tar -tf "$ART" >/dev/null 2>&1 || die "tar -tf failed on $ART"
  fi
  [ -f "$TARGET/pg_wal.tar" ] && tar -tf "$TARGET/pg_wal.tar" >/dev/null 2>&1
  [ -f "$TARGET/backup_manifest" ] || log "WARNING: backup_manifest missing (old pg_basebackup?)"
else
  [ -f "$TARGET/PG_VERSION" ] || [ -f "$TARGET/backup_label" ] || [ -f "$TARGET/base/PG_VERSION" ] \
    || die "plain basebackup looks empty: $TARGET"
fi

# 写 manifest
{
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "stamp": "%s",\n' "$STAMP"
  printf '  "label": "%s",\n' "$LABEL"
  printf '  "format": "%s",\n' "$FMT"
  printf '  "gzip": %s,\n' "$([ "$GZIP" -eq 1 ] && echo true || echo false)"
  printf '  "durationSeconds": %s,\n' "$DUR"
  printf '  "source": "%s:%s",\n' "$PGHOST" "$PGPORT"
  printf '  "path": "%s",\n' "$TARGET"
  printf '  "bytes": %s,\n' "$(du -sb "$TARGET" 2>/dev/null | awk '{print $1}' || echo 0)"
  printf '  "slot": %s,\n' "$([ -n "$SLOT" ] && printf '"%s"' "$SLOT" || echo null)"
  printf '  "verified": true\n'
  printf '}\n'
} > "$MANIFEST_STAMPED"
cp -f "$MANIFEST_STAMPED" "$MANIFEST_LATEST"
log "manifest ok: $(basename "$MANIFEST_STAMPED")"

# 滚动保留: 只删最旧的 basebackup-* 目录
mapfile -t ALL_BB < <(ls -1dt "$BACKUP_ROOT"/basebackup-* 2>/dev/null | grep -v '\.json$' || true)
# ls -1dt 对目录有效; 过滤出目录
DIRS=()
for d in "${ALL_BB[@]:-}"; do
  [ -d "$d" ] && DIRS+=("$d")
done
if [ "${#DIRS[@]}" -gt "$KEEP" ]; then
  for old in "${DIRS[@]:$KEEP}"; do
    log "retention: removing old basebackup $old"
    rm -rf "$old"
  done
fi
# manifest 同步滚动
ls -1t "$BACKUP_ROOT"/basebackup-manifest-*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

log "done. root=$BACKUP_ROOT keep=$KEEP"
