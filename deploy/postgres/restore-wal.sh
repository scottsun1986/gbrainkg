#!/usr/bin/env bash
# WAL 恢复包装脚本 — 供 restore_command 调用 (ROI-5 / PITR)
#
# 用法 (PostgreSQL 传参, 注意与 archive 侧顺序相反):
#   restore_command = '/bin/bash /usr/local/sbin/pg-archive-wal.sh.restore %f %p'
#   参数1 %f = 归档中的 WAL 文件名; 参数2 %p = 恢复目标路径
#
# 环境变量:
#   PG_ARCHIVE_DIR  归档目录 (默认 /data/pg-archive/${PG_ARCHIVE_DB:-main})
#
# 约定:
#   - 找不到文件时退出 1 (PostgreSQL 会结束恢复或尝试下一个来源, 这是正确行为)
#   - 幂等: 目标已存在则成功
set -euo pipefail

WALNAME="${1:?usage: pg-archive-wal.sh.restore %f %p}"
DEST="${2:?usage: pg-archive-wal.sh.restore %f %p}"

ARCHIVE_DIR="${PG_ARCHIVE_DIR:-/data/pg-archive/${PG_ARCHIVE_DB:-main}}"
SRC="$ARCHIVE_DIR/$WALNAME"

if [ -f "$DEST" ]; then
  exit 0
fi
if [ ! -f "$SRC" ]; then
  # 未归档: 让 PostgreSQL 决定 (结束恢复 / 报错)
  exit 1
fi
cp -f "$SRC" "$DEST"
exit 0
