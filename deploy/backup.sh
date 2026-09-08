#!/usr/bin/env bash
# LLMWiki 数据库与文件备份脚本 (OPT-4)
# - PostgreSQL 逻辑备份 (pg_dump custom format, 可用 pg_restore 恢复)
# - 上传原始文件 + GBrain 仓库归档
# - 本地滚动保留 (默认 7 份), 可选 MinIO/S3 异地镜像
# 用法:
#   ./backup.sh                     # 手动执行
#   systemd timer 每日自动执行       # 见 deploy/systemd/llmwiki-backup.timer
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.local/share/llmwiki/backups}"
RETAIN_COUNT="${BACKUP_RETAIN_COUNT:-7}"
LLMWIKI_DATA_ROOT="${LLMWIKI_DATA_ROOT:-$HOME/.local/share/llmwiki}"
DB_CONTAINER="${BACKUP_DB_CONTAINER:-llmwiki-postgres}"
DB_USER="${BACKUP_DB_USER:-llmwiki}"
DB_NAME="${BACKUP_DB_NAME:-llmwiki}"
S3_ALIAS="${BACKUP_S3_ALIAS:-}"   # 例: backup-remote (需已 mc alias set)

log() { echo "[backup $(date '+%F %T')] $*"; }

mkdir -p "$BACKUP_ROOT"

# ---- 1. PostgreSQL ----
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "${DATABASE_URL:-postgresql://$DB_USER@127.0.0.1:5433/$DB_NAME}" \
    --format=custom --no-owner --file "$BACKUP_ROOT/db-$STAMP.dump"
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
  docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" --format=custom --no-owner "$DB_NAME" \
    > "$BACKUP_ROOT/db-$STAMP.dump"
else
  log "ERROR: neither pg_dump nor container $DB_CONTAINER available"; exit 1
fi
log "database dump ok: db-$STAMP.dump ($(du -h "$BACKUP_ROOT/db-$STAMP.dump" | cut -f1))"

# ---- 2. 文件 (上传原件 + GBrain 编译仓库) ----
FILES_TAR="$BACKUP_ROOT/files-$STAMP.tar.gz"
if [ -d "$LLMWIKI_DATA_ROOT" ]; then
  tar -czf "$FILES_TAR" -C "$LLMWIKI_DATA_ROOT" uploads brain_repos 2>/dev/null || true
  log "files archive ok: files-$STAMP.tar.gz ($(du -h "$FILES_TAR" | cut -f1))"
fi

# ---- 3. 异地镜像 (可选) ----
if [ -n "$S3_ALIAS" ] && command -v mc >/dev/null 2>&1; then
  mc cp "$BACKUP_ROOT/db-$STAMP.dump" "$S3_ALIAS/" >/dev/null && \
  mc cp "$FILES_TAR" "$S3_ALIAS/" >/dev/null && \
  log "remote mirror ok -> $S3_ALIAS"
fi

# ---- 4. 滚动保留 ----
ls -1t "$BACKUP_ROOT"/db-*.dump 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm -f
ls -1t "$BACKUP_ROOT"/files-*.tar.gz 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm -f

log "done. backup root: $BACKUP_ROOT"
