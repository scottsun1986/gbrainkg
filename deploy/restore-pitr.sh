#!/usr/bin/env bash
# PITR 恢复脚本 (ROI-5): basebackup + WAL 归档 → 独立恢复目录 (+可选临时实例)
#
#   ⛔ 安全铁律:
#   - 默认目标是独立目录 (如 /data/pg-drill/pitr-<STAMP>), 绝不覆盖生产 data
#     directory (/var/lib/postgresql/16/main)。
#   - 若坚持写生产 data directory, 必须同时给:
#       --force-production  且  env FORCE_PRODUCTION_RESTORE=YES_I_MEAN_IT
#     并交互二次确认 (或 FORCE_PRODUCTION_ASSUME_YES=1 跳过交互, 仅供自动化)。
#
# 用法:
#   ./restore-pitr.sh --base DIR --archive DIR [options]
#
#   --base DIR              pg_basebackup 产物目录 (basebackup-<STAMP> 或解包后的 datadir)
#   --base-tar FILE         tar 格式 base.tar[.gz] (配合 --wal-tar)
#   --wal-tar FILE          tar 格式 pg_wal.tar[.gz]
#   --archive DIR           WAL 归档目录 (PG_ARCHIVE_DIR, 默认 /data/pg-archive/main)
#   --target-dir DIR        恢复落地目录 (默认 /data/pg-drill/pitr-<STAMP>)
#   --target-time TIME      recovery_target_time (ISO, 建议带时区)
#   --target-lsn LSN        recovery_target_lsn
#   --target-name NAME      recovery_target_name
#   --target-latest         恢复到归档末尾 (默认)
#   --start-port PORT       恢复后在该端口启动临时实例 (默认 0=不启动)
#   --drill-db NAME         启动后把 --source-db 改名为 NAME (例 llmwiki_pitr_drill)
#   --source-db NAME        默认 llmwiki
#   --keep-running          演练结束后不 stop 临时实例
#   --force-production      危险: 允许写生产 data directory (需 env 双重确认)
#   --dry-run               只打印计划
#   --help
#
# 环境变量:
#   PG_ARCHIVE_DIR / PITR_ARCHIVE_DIR   归档目录
#   PITR_DRILL_ROOT                     演练根, 默认 /data/pg-drill
#   PITR_PG_BIN                         postgres 二进制目录 (默认 PATH /usr/lib/postgresql/16/bin)
#   PITR_RUN_AS                         运行 postgres 的用户, 默认 postgres
#   FORCE_PRODUCTION_RESTORE            必须 = YES_I_MEAN_IT 才允许 --force-production
#   FORCE_PRODUCTION_ASSUME_YES         =1 跳过交互确认 (自动化)
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
DRILL_ROOT="${PITR_DRILL_ROOT:-/data/pg-drill}"
ARCHIVE_DIR="${PITR_ARCHIVE_DIR:-${PG_ARCHIVE_DIR:-/data/pg-archive/main}}"
TARGET_DIR=""
BASE_DIR=""
BASE_TAR=""
WAL_TAR=""
TARGET_TIME=""
TARGET_LSN=""
TARGET_NAME=""
TARGET_LATEST=1
START_PORT=0
DRILL_DB=""
SOURCE_DB="llmwiki"
KEEP_RUNNING=0
FORCE_PROD=0
DRY=0
PG_BIN="${PITR_PG_BIN:-}"
RUN_AS="${PITR_RUN_AS:-postgres}"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --base) shift; BASE_DIR="${1:-}" ;;
    --base-tar) shift; BASE_TAR="${1:-}" ;;
    --wal-tar) shift; WAL_TAR="${1:-}" ;;
    --archive) shift; ARCHIVE_DIR="${1:-}" ;;
    --target-dir) shift; TARGET_DIR="${1:-}" ;;
    --target-time) shift; TARGET_TIME="${1:-}"; TARGET_LATEST=0 ;;
    --target-lsn) shift; TARGET_LSN="${1:-}"; TARGET_LATEST=0 ;;
    --target-name) shift; TARGET_NAME="${1:-}"; TARGET_LATEST=0 ;;
    --target-latest) TARGET_LATEST=1; TARGET_TIME=""; TARGET_LSN=""; TARGET_NAME="" ;;
    --start-port) shift; START_PORT="${1:-0}" ;;
    --drill-db) shift; DRILL_DB="${1:-}" ;;
    --source-db) shift; SOURCE_DB="${1:-}" ;;
    --keep-running) KEEP_RUNNING=1 ;;
    --force-production) FORCE_PROD=1 ;;
    --dry-run) DRY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[restore-pitr $(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }

[ -n "$BASE_DIR" ] || [ -n "$BASE_TAR" ] || die "need --base DIR or --base-tar FILE"
[ -d "$ARCHIVE_DIR" ] || die "archive dir missing: $ARCHIVE_DIR"
[ -n "$TARGET_DIR" ] || TARGET_DIR="$DRILL_ROOT/pitr-$STAMP"

PROD_DATA_DIR="${PITR_PROD_DATA_DIR:-/var/lib/postgresql/16/main}"

# ---- 安全门禁: 生产 data directory ----
is_prod_dir() {
  local a b
  a="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  b="$(readlink -f "$PROD_DATA_DIR" 2>/dev/null || echo "$PROD_DATA_DIR")"
  [ "$a" = "$b" ]
}

if is_prod_dir "$TARGET_DIR"; then
  if [ "$FORCE_PROD" -ne 1 ]; then
    die "target-dir is the PRODUCTION data directory ($TARGET_DIR). Refusing. Use a drill dir (e.g. $DRILL_ROOT/pitr-$STAMP)."
  fi
  if [ "${FORCE_PRODUCTION_RESTORE:-}" != "YES_I_MEAN_IT" ]; then
    die "--force-production also requires env FORCE_PRODUCTION_RESTORE=YES_I_MEAN_IT (got: '${FORCE_PRODUCTION_RESTORE:-}')."
  fi
  log "!!! DANGER: --force-production targeting PRODUCTION data dir $TARGET_DIR"
  if [ "${FORCE_PRODUCTION_ASSUME_YES:-0}" != "1" ]; then
    printf 'Type exactly OVERWRITE-PRODUCTION-DATA to continue: '
    read -r CONFIRM
    [ "$CONFIRM" = "OVERWRITE-PRODUCTION-DATA" ] || die "confirmation mismatch; aborting."
  else
    log "FORCE_PRODUCTION_ASSUME_YES=1 — skipping interactive confirm"
  fi
fi

# 演练库名门禁 (与 restore-drill.sh 同口径; 生产库名禁止)
if [ -n "$DRILL_DB" ]; then
  case "$DRILL_DB" in
    llmwiki|llmwiki_inst*|postgres|template0|template1)
      die "refusing drill-db production-like name: '$DRILL_DB'" ;;
  esac
fi

# 找 postgres 二进制
if [ -z "$PG_BIN" ]; then
  for c in /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin /usr/bin; do
    if [ -x "$c/pg_ctl" ]; then PG_BIN="$c"; break; fi
  done
fi
[ -n "$PG_BIN" ] && [ -x "$PG_BIN/pg_ctl" ] || die "cannot find pg_ctl (set PITR_PG_BIN)"

echo "=================================================="
echo "  PITR restore (isolated target by default)"
echo "=================================================="
echo "  base         : ${BASE_DIR:-$BASE_TAR}"
echo "  archive      : $ARCHIVE_DIR"
echo "  target-dir   : $TARGET_DIR"
echo "  target       : $([ "$TARGET_LATEST" -eq 1 ] && echo 'latest archived WAL' || echo "${TARGET_TIME:-$TARGET_LSN:-$TARGET_NAME}")"
echo "  start-port   : ${START_PORT:-0} (0 = do not start)"
echo "  drill-db     : ${DRILL_DB:-<none>} (rename of $SOURCE_DB after start)"
echo "  force-prod   : $FORCE_PROD"
echo "  mode         : $([ "$DRY" -eq 1 ] && echo DRY-RUN || echo EXECUTE)"
echo "=================================================="

if [ "$DRY" -eq 1 ]; then
  log "dry-run plan:"
  echo "  1. materialize basebackup -> $TARGET_DIR"
  echo "  2. write restore_command + recovery target into postgresql.auto.conf"
  echo "  3. touch recovery.signal"
  echo "  4. optional: pg_ctl start -o '-p $START_PORT'"
  echo "  5. optional: ALTER DATABASE $SOURCE_DB RENAME TO $DRILL_DB"
  echo "  6. verification SQL + RPO/RTO report"
  exit 0
fi

RTO_START="$(date +%s.%N 2>/dev/null || date +%s)"

# ---- 1. 落地 basebackup ----
log "materializing basebackup into $TARGET_DIR ..."
mkdir -p "$(dirname "$TARGET_DIR")"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

if [ -n "$BASE_DIR" ]; then
  # plain 格式: 直接拷贝 (排除部分可再生文件); tar 格式目录: 解 base.tar
  if [ -f "$BASE_DIR/base.tar" ] || [ -f "$BASE_DIR/base.tar.gz" ]; then
    if [ -f "$BASE_DIR/base.tar.gz" ]; then
      tar -xzf "$BASE_DIR/base.tar.gz" -C "$TARGET_DIR"
    else
      tar -xf "$BASE_DIR/base.tar" -C "$TARGET_DIR"
    fi
    if [ -f "$BASE_DIR/pg_wal.tar" ]; then
      mkdir -p "$TARGET_DIR/pg_wal"
      tar -xf "$BASE_DIR/pg_wal.tar" -C "$TARGET_DIR/pg_wal"
    elif [ -f "$BASE_DIR/pg_wal.tar.gz" ]; then
      mkdir -p "$TARGET_DIR/pg_wal"
      tar -xzf "$BASE_DIR/pg_wal.tar.gz" -C "$TARGET_DIR/pg_wal"
    fi
  elif [ -f "$BASE_DIR/PG_VERSION" ] || [ -d "$BASE_DIR/base" ]; then
    cp -a "$BASE_DIR"/. "$TARGET_DIR"/
  else
    die "unrecognized basebackup layout: $BASE_DIR"
  fi
else
  if [[ "$BASE_TAR" == *.gz ]]; then
    tar -xzf "$BASE_TAR" -C "$TARGET_DIR"
  else
    tar -xf "$BASE_TAR" -C "$TARGET_DIR"
  fi
  if [ -n "$WAL_TAR" ]; then
    mkdir -p "$TARGET_DIR/pg_wal"
    if [[ "$WAL_TAR" == *.gz ]]; then
      tar -xzf "$WAL_TAR" -C "$TARGET_DIR/pg_wal"
    else
      tar -xf "$WAL_TAR" -C "$TARGET_DIR/pg_wal"
    fi
  fi
fi

# base.tar 可能解开成 base/ 子目录 (pg_basebackup -Ft 的 base.tar 内容即 datadir 根)
if [ ! -f "$TARGET_DIR/PG_VERSION" ] && [ -f "$TARGET_DIR/base/PG_VERSION" ]; then
  # 这是整包解到了 base/ 的情况 (少见); 提升一层
  log "normalizing nested base/ layout ..."
  shopt -s dotglob
  mv "$TARGET_DIR/base"/* "$TARGET_DIR"/
  rmdir "$TARGET_DIR/base"
  shopt -u dotglob
fi
[ -f "$TARGET_DIR/PG_VERSION" ] || die "PG_VERSION missing after extract — bad basebackup"
log "basebackup materialized ($(du -sh "$TARGET_DIR" | cut -f1))"

# ---- 2. 写恢复配置 (PG16: postgresql.auto.conf + recovery.signal) ----
log "writing recovery settings ..."
# 清掉 basebackup 自带的 standby/recovery 残留
rm -f "$TARGET_DIR/recovery.signal" "$TARGET_DIR/standby.signal"

# Debian/Ubuntu: postgresql.conf 在 /etc/postgresql/<ver>/<cluster>/, 不在 data directory
# 内, pg_basebackup 不会带上。缺失时生成最小可启动配置 (data_directory 即当前目录)。
if [ ! -f "$TARGET_DIR/postgresql.conf" ]; then
  log "postgresql.conf missing (Debian layout) — writing minimal config"
  {
    echo "# generated by restore-pitr.sh $STAMP (Debian-layout basebackup)"
    echo "data_directory = '$TARGET_DIR'"
    echo "hba_file = '$TARGET_DIR/pg_hba.conf'"
    echo "ident_file = '$TARGET_DIR/pg_ident.conf'"
    echo "external_pid_file = '$TARGET_DIR/postmaster.pid'"
    echo "listen_addresses = '127.0.0.1'"
    echo "unix_socket_directories = '$TARGET_DIR'"
    echo "max_connections = 100"
    echo "shared_buffers = 128MB"
    echo "dynamic_shared_memory_type = posix"
    echo "logging_collector = off"
  } > "$TARGET_DIR/postgresql.conf"
  # pg_hba: 本地 peer 即可
  if [ ! -f "$TARGET_DIR/pg_hba.conf" ]; then
    {
      echo "local all all peer"
      echo "host all all 127.0.0.1/32 trust"
      echo "local replication all peer"
      echo "host replication all 127.0.0.1/32 trust"
    } > "$TARGET_DIR/pg_hba.conf"
  fi
  [ -f "$TARGET_DIR/pg_ident.conf" ] || echo "# empty" > "$TARGET_DIR/pg_ident.conf"
fi

# restore_command: 优先包装脚本 restore 侧 (deploy/postgres/restore-wal.sh 装到
# /usr/local/sbin/pg-archive-wal.sh.restore), 否则 cp
RESTORE_CMD="cp $ARCHIVE_DIR/%f %p"
if [ -x /usr/local/sbin/pg-archive-wal.sh.restore ]; then
  RESTORE_CMD="/bin/bash /usr/local/sbin/pg-archive-wal.sh.restore %f %p"
elif [ -f "$(dirname "$0")/postgres/restore-wal.sh" ]; then
  RESTORE_CMD="/bin/bash $(readlink -f "$(dirname "$0")/postgres/restore-wal.sh") %f %p"
fi

{
  echo ""
  echo "# --- written by restore-pitr.sh $STAMP ---"
  if [ "$START_PORT" -gt 0 ]; then
    echo "port = $START_PORT"
  else
    echo "port = 55432"
  fi
  echo "listen_addresses = '127.0.0.1'"
  echo "hot_standby = on"
  echo "archive_mode = off"
  echo "restore_command = '$RESTORE_CMD'"
  if [ -n "$TARGET_TIME" ]; then
    echo "recovery_target_time = '$TARGET_TIME'"
    echo "recovery_target_action = 'promote'"
    echo "recovery_target_inclusive = on"
  elif [ -n "$TARGET_LSN" ]; then
    echo "recovery_target_lsn = '$TARGET_LSN'"
    echo "recovery_target_action = 'promote'"
  elif [ -n "$TARGET_NAME" ]; then
    echo "recovery_target_name = '$TARGET_NAME'"
    echo "recovery_target_action = 'promote'"
  fi
  echo "recovery_target_timeline = 'latest'"
} >> "$TARGET_DIR/postgresql.auto.conf"

touch "$TARGET_DIR/recovery.signal"
chown -R "$RUN_AS":"$RUN_AS" "$TARGET_DIR" 2>/dev/null || true
chmod 700 "$TARGET_DIR" 2>/dev/null || true

# ---- 3. 可选: 启动临时实例 (RTO 计时包含恢复 replay) ----
STARTED=0
if [ "$START_PORT" -gt 0 ]; then
  log "starting recovered instance on 127.0.0.1:$START_PORT (replay until target) ..."
  if [ "$(id -un)" = "$RUN_AS" ]; then
    "$PG_BIN/pg_ctl" -D "$TARGET_DIR" -l "$TARGET_DIR/startup.log" -o "-p $START_PORT" -w -t 120 start \
      || die "pg_ctl start failed; see $TARGET_DIR/startup.log"
  else
    sudo -n -u "$RUN_AS" "$PG_BIN/pg_ctl" -D "$TARGET_DIR" -l "$TARGET_DIR/startup.log" -o "-p $START_PORT" -w -t 120 start \
      || die "pg_ctl start failed; see $TARGET_DIR/startup.log"
  fi
  STARTED=1
  log "recovered instance is up (port $START_PORT)"
fi

RTO_END="$(date +%s.%N 2>/dev/null || date +%s)"
RTO_S="$(awk -v a="$RTO_START" -v b="$RTO_END" 'BEGIN{printf "%d", (b-a)}')"

# ---- 4. 验证 SQL + 可选改名演练库 ----
VERIFY_OUT=""
if [ "$STARTED" -eq 1 ]; then
  psql_rd() {
    if [ "$(id -un)" = "$RUN_AS" ]; then
      "$PG_BIN/psql" -h 127.0.0.1 -p "$START_PORT" -U "$RUN_AS" -d "$1" -v ON_ERROR_STOP=1 ${2:+-c} ${2:+"$2"}
    else
      sudo -n -u "$RUN_AS" "$PG_BIN/psql" -h 127.0.0.1 -p "$START_PORT" -U "$RUN_AS" -d "$1" -v ON_ERROR_STOP=1 ${2:+-c} ${2:+"$2"}
    fi
  }
  log "recovery status:"
  psql_rd postgres "SELECT pg_is_in_recovery() AS still_in_recovery, pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), now() AS instance_now;" || true

  if [ -n "$DRILL_DB" ]; then
    log "renaming $SOURCE_DB -> $DRILL_DB in recovered instance ..."
    psql_rd postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$SOURCE_DB' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
    psql_rd postgres "ALTER DATABASE \"$SOURCE_DB\" RENAME TO \"$DRILL_DB\";"
  fi
  CHECK_DB="${DRILL_DB:-$SOURCE_DB}"
  log "verification on $CHECK_DB:"
  VERIFY_OUT="$(psql_rd "$CHECK_DB" "SELECT
    (SELECT count(*) FROM pg_tables WHERE schemaname='public') AS tables,
    (SELECT count(*) FROM \"User\") AS users,
    (SELECT count(*) FROM \"KnowledgeBase\") AS kbs,
    (SELECT count(*) FROM \"Document\") AS docs,
    (SELECT count(*) FROM \"Chunk\") AS chunks;" 2>&1)" || log "WARNING: verify query failed: $VERIFY_OUT"
  echo "$VERIFY_OUT"
fi

# ---- 5. 清理临时实例 ----
if [ "$STARTED" -eq 1 ] && [ "$KEEP_RUNNING" -ne 1 ]; then
  log "stopping recovered instance (use --keep-running to leave it up) ..."
  if [ "$(id -un)" = "$RUN_AS" ]; then
    "$PG_BIN/pg_ctl" -D "$TARGET_DIR" -m fast -w -t 60 stop >/dev/null 2>&1 || true
  else
    sudo -n -u "$RUN_AS" "$PG_BIN/pg_ctl" -D "$TARGET_DIR" -m fast -w -t 60 stop >/dev/null 2>&1 || true
  fi
fi

# ---- 6. RPO/RTO 报告 ----
# RPO: 对「恢复到指定时间点」: 数据丢失窗口 = 灾难时刻 - recovery_target_time
#      对「恢复到归档末尾」:  = 未归档 WAL 的年龄 (archive_timeout 上界 5min)
# 这里打印目标点与实例时钟, 供人工/上层脚本计算。
echo ""
echo "=================================================="
echo "  PITR restore result"
echo "=================================================="
echo "  target-dir    : $TARGET_DIR"
echo "  recovery      : $([ "$TARGET_LATEST" -eq 1 ] && echo 'to latest archived WAL' || echo "to ${TARGET_TIME:-$TARGET_LSN:-$TARGET_NAME}")"
echo "  drill-db      : ${DRILL_DB:-<none>}"
echo "  RTO (restore) : ${RTO_S}s  — extract + recovery config + replay/start + verify"
echo "  RPO guidance  :"
if [ -n "$TARGET_TIME" ]; then
  echo "                  point-in-time target = $TARGET_TIME"
  echo "                  RPO = disaster_time - target_time  (choose target just before disaster)"
else
  echo "                  latest-WAL restore; RPO ≤ archive_timeout (default 300s) if archiving healthy"
  echo "                  measure: disaster_time - max(commit times present in recovered DB)"
fi
echo "  next          : record numbers in docs/postgres-pitr-ha-runbook.md + deploy/restore-drill.md"
echo "=================================================="
log "pitr restore complete."
