#!/usr/bin/env bash
# 流复制从库 (Hot Standby) 搭建脚本 (ROI-5 / HA 基础)
#
# 在主库上创建复制槽 + 用 pg_basebackup 拉出从库数据目录 + 以 standby 启动。
# 默认落地到独立目录/端口, 不影响生产 API。
#
# 用法 (在主库所在主机上, 需 sudo):
#   ./setup-replica.sh --slot standby1 --data-dir /data/pg-standby/standby1 --port 5433
#   ./setup-replica.sh --dry-run
#   ./setup-replica.sh --teardown --data-dir /data/pg-standby/standby1 --slot standby1
#
# 前置:
#   - 主库已启用 wal_level=replica, max_wal_senders/max_replication_slots > 0
#     (见 deploy/postgres/enable-pitr.sql)
#   - pg_hba 允许 replication (本机 127.0.0.1 默认已有)
#
# 环境变量:
#   REPL_PRIMARY_HOST  默认 127.0.0.1
#   REPL_PRIMARY_PORT  默认 5432
#   REPL_USER          复制用户, 默认 postgres (需 REPLICATION 属性)
#   REPL_PASSWORD      密码 (写入 primary_conninfo; 勿提交仓库)
#   PITR_USE_SUDO      =1 用 sudo -u postgres (本地 peer)
set -euo pipefail

SLOT="standby1"
DATA_DIR="/data/pg-standby/standby1"
PORT=5433
PRIMARY_HOST="${REPL_PRIMARY_HOST:-127.0.0.1}"
PRIMARY_PORT="${REPL_PRIMARY_PORT:-5432}"
REPL_USER="${REPL_USER:-postgres}"
REPL_PASSWORD="${REPL_PASSWORD:-}"
APP_NAME="standby1"
DRY=0
TEARDOWN=0
USE_SUDO="${PITR_USE_SUDO:-1}"

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --slot) shift; SLOT="${1:-}"; APP_NAME="$SLOT" ;;
    --data-dir) shift; DATA_DIR="${1:-}" ;;
    --port) shift; PORT="${1:-}" ;;
    --app-name) shift; APP_NAME="${1:-}" ;;
    --primary-host) shift; PRIMARY_HOST="${1:-}" ;;
    --primary-port) shift; PRIMARY_PORT="${1:-}" ;;
    --user) shift; REPL_USER="${1:-}" ;;
    --teardown) TEARDOWN=1 ;;
    --dry-run) DRY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[setup-replica $(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }

as_pg() {
  if [ "$USE_SUDO" = "1" ] && [ "$(id -un)" != "postgres" ]; then
    sudo -n -u postgres "$@"
  else
    "$@"
  fi
}

find_pg_bin() {
  for c in /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin /usr/bin; do
    if [ -x "$c/pg_basebackup" ]; then echo "$c"; return; fi
  done
  echo ""
}
PG_BIN="$(find_pg_bin)"
[ -n "$PG_BIN" ] || die "pg_basebackup not found"

echo "=================================================="
echo "  streaming replica setup"
echo "=================================================="
echo "  primary   : $PRIMARY_HOST:$PRIMARY_PORT (user=$REPL_USER)"
echo "  slot      : $SLOT"
echo "  data-dir  : $DATA_DIR"
echo "  port      : $PORT"
echo "  mode      : $([ "$TEARDOWN" -eq 1 ] && echo TEARDOWN || echo SETUP)$( [ "$DRY" -eq 1 ] && echo ' (dry-run)' )"
echo "=================================================="

if [ "$DRY" -eq 1 ]; then
  log "dry-run: create slot $SLOT, pg_basebackup -R -> $DATA_DIR, start on :$PORT"
  exit 0
fi

# ---- teardown ----
if [ "$TEARDOWN" -eq 1 ]; then
  log "teardown replica $DATA_DIR ..."
  if [ -d "$DATA_DIR" ]; then
    as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
    as_pg rm -rf "$DATA_DIR"
  fi
  as_pg psql -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" -d postgres \
    -c "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '$SLOT';" || true
  log "teardown done"
  exit 0
fi

# ---- 1. 复制槽 (幂等) ----
log "ensuring replication slot $SLOT ..."
as_pg psql -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '$SLOT')
  THEN 'slot exists: $SLOT'
  ELSE pg_create_physical_replication_slot('$SLOT')::text
END;
SQL

# ---- 2. pg_basebackup -R (自动写 standby.signal + primary_conninfo) ----
[ -d "$DATA_DIR" ] && die "data-dir already exists: $DATA_DIR (teardown first)"
mkdir -p "$(dirname "$DATA_DIR")"

CONNINFO="host=$PRIMARY_HOST port=$PRIMARY_PORT user=$REPL_USER application_name=$APP_NAME"
if [ -n "$REPL_PASSWORD" ]; then
  export PGPASSWORD="$REPL_PASSWORD"
  CONNINFO="$CONNINFO password=$REPL_PASSWORD"
fi

log "pg_basebackup -R -X stream -> $DATA_DIR ..."
as_pg env ${PGPASSWORD:+PGPASSWORD="$PGPASSWORD"} "$PG_BIN/pg_basebackup" \
  -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" \
  -D "$DATA_DIR" -Fp -X stream -R \
  -S "$SLOT" -l "replica-$APP_NAME-$(date +%Y%m%d-%H%M%S)" -v \
  || die "pg_basebackup failed"

# -R 写入的 primary_conninfo 可能不含 password; 确保 slot/application_name 在位
AUTO="$DATA_DIR/postgresql.auto.conf"
{
  echo ""
  echo "# --- written by setup-replica.sh ---"
  echo "listen_addresses = '127.0.0.1'"
  echo "port = $PORT"
  echo "hot_standby = on"
  echo "primary_slot_name = '$SLOT'"
  echo "primary_conninfo = '$CONNINFO'"
} >> "$AUTO"

touch "$DATA_DIR/standby.signal"
rm -f "$DATA_DIR/recovery.signal"
chown -R postgres:postgres "$DATA_DIR" 2>/dev/null || true
chmod 700 "$DATA_DIR" 2>/dev/null || true

# ---- 3. 启动从库 ----
log "starting standby on 127.0.0.1:$PORT ..."
as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$DATA_DIR/startup.log" -w -t 60 start \
  || die "standby start failed; see $DATA_DIR/startup.log"

sleep 2
log "primary view pg_stat_replication:"
as_pg psql -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" -d postgres \
  -c "SELECT application_name, state, sync_state, replay_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       active FROM pg_stat_replication;"

log "standby read-only check:"
as_pg psql -h 127.0.0.1 -p "$PORT" -U "$REPL_USER" -d postgres \
  -c "SELECT pg_is_in_recovery() AS is_standby,
       pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"

echo ""
echo "=================================================="
echo "  replica is up"
echo "=================================================="
echo "  verify read-only rejection:"
echo "    psql -h 127.0.0.1 -p $PORT -U $REPL_USER -d llmwiki -c 'CREATE TABLE t(i int);'"
echo "    (expect: cannot execute INSERT/DDL in a read-only transaction)"
echo "  lag monitor:"
echo "    psql -h 127.0.0.1 -p $PRIMARY_PORT -U $REPL_USER -d postgres -c \\"
echo "      'SELECT application_name, replay_lag_bytes FROM pg_stat_replication;'"
echo "  teardown:"
echo "    sudo bash deploy/postgres/setup-replica.sh --teardown --slot $SLOT --data-dir $DATA_DIR"
echo "=================================================="
