#!/usr/bin/env bash
# 从库提升 (promote) 流程 (ROI-5 / 故障切换第 2 步)
#
# 用法:
#   ./promote-standby.sh --data-dir /data/pg-standby/standby1
#   ./promote-standby.sh --data-dir DIR --port 5432 --wait
#
# 步骤 (与 docs/postgres-pitr-ha-runbook.md 故障切换 3 步对齐):
#   1. 检测: 主库不可用 (见 runbook 检测清单)
#   2. promote: 本脚本 — pg_ctl promote, 等待退出恢复态
#   3. 改连接串: 把应用 DATABASE_URL 指到新主 (人工/配置中心), 验证三实例 API
#
# 环境变量:
#   PITR_PG_BIN / PITR_RUN_AS   同 restore-pitr.sh
set -euo pipefail

DATA_DIR=""
PORT=""
WAIT=1
PG_BIN="${PITR_PG_BIN:-}"
RUN_AS="${PITR_RUN_AS:-postgres}"

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) shift; DATA_DIR="${1:-}" ;;
    --port) shift; PORT="${1:-}" ;;
    --no-wait) WAIT=0 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[promote-standby $(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }

[ -n "$DATA_DIR" ] || die "--data-dir required"
[ -d "$DATA_DIR" ] || die "no such data dir: $DATA_DIR"

if [ -z "$PG_BIN" ]; then
  for c in /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin /usr/bin; do
    if [ -x "$c/pg_ctl" ]; then PG_BIN="$c"; break; fi
  done
fi
[ -n "$PG_BIN" ] || die "pg_ctl not found"

as_pg() {
  if [ "$(id -un)" = "$RUN_AS" ]; then "$@"; else sudo -n -u "$RUN_AS" "$@"; fi
}

# 幂等: 已是主库则只报告
if as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1; then
  log "instance running; checking recovery state ..."
fi

log "promoting $DATA_DIR ..."
as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" promote || die "pg_ctl promote failed"

if [ "$WAIT" -eq 1 ]; then
  for i in $(seq 1 30); do
    # promote 完成后 postgresql.auto.conf 中 recovery.signal 消失, 且可写
    if [ ! -f "$DATA_DIR/recovery.signal" ] && [ ! -f "$DATA_DIR/standby.signal" ]; then
      break
    fi
    sleep 1
  done
fi

if [ -n "$PORT" ]; then
  log "post-promote status:"
  as_pg "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$RUN_AS" -d postgres \
    -c "SELECT NOT pg_is_in_recovery() AS is_primary, pg_current_wal_lsn() AS wal_lsn, now();"
fi

echo ""
echo "=================================================="
echo "  promote complete — 故障切换剩余步骤 (runbook)"
echo "=================================================="
echo "  3. 改连接串: 更新 DATABASE_URL / GBRAIN_DATABASE_URL 指向本节点"
echo "     (inst1/2/3 systemd 环境或 /home/ubuntu/gbrainkg*/.env), 然后:"
echo "       systemctl --user restart llmwiki-api llmwiki-web   # 按实例"
echo "     并验证: curl -sf http://127.0.0.1:3000/api/health"
echo "  注意: 旧主恢复后需重建为从库 (setup-replica.sh --teardown && setup-replica.sh)"
echo "=================================================="
