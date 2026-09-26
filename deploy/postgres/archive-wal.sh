#!/usr/bin/env bash
# WAL 归档包装脚本 — 供 archive_command 调用 (ROI-5 / PITR)
#
# postgresql.conf:
#   archive_command = '/bin/bash /usr/local/sbin/pg-archive-wal.sh %p %f'
#
# 用法 (PostgreSQL 传参):
#   pg-archive-wal.sh %p %f     # %p=WAL 源路径, %f=WAL 文件名
#
# 环境变量:
#   PG_ARCHIVE_DIR  归档目录 (默认 /data/pg-archive/${PG_ARCHIVE_DB:-main})
#   PG_ARCHIVE_DB   集群标识, 仅用于拼默认目录名
#
# 约定:
#   - 幂等: 目标已存在则直接成功 (重复归档/恢复重试)
#   - 原子: 先写 .partial 再 mv, 避免半截 WAL 被 restore_command 误用
#   - 失败必须非零退出, 让 PostgreSQL 保留该 WAL 并重试 (不要吞错)
set -euo pipefail

SRC="${1:?usage: pg-archive-wal.sh %p %f}"
WALNAME="${2:?usage: pg-archive-wal.sh %p %f}"

ARCHIVE_DIR="${PG_ARCHIVE_DIR:-/data/pg-archive/${PG_ARCHIVE_DB:-main}}"
DEST="$ARCHIVE_DIR/$WALNAME"
TMP="$ARCHIVE_DIR/$WALNAME.partial"

mkdir -p "$ARCHIVE_DIR"

# 已归档过 → 成功 (幂等)
if [ -f "$DEST" ]; then
  exit 0
fi

# 源文件必须在 (PostgreSQL 传入后不会提前删除; 缺失说明异常)
if [ ! -f "$SRC" ]; then
  echo "pg-archive-wal: source missing: $SRC" >&2
  exit 1
fi

cp -f "$SRC" "$TMP"
mv -f "$TMP" "$DEST"
exit 0
