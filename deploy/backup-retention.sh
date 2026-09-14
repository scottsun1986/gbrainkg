#!/usr/bin/env bash
# 备份滚动清理（对所有备份落地位置统一执行保留策略）
# 策略：
#   - 代码备份 gbrainkg_code_*.tar.gz：保留最新 KEEP_CODE 份
#   - 库备份 llmwiki_*.sql.gz：最新 1 份永远保留，其余超过 KEEP_DB_DAYS 天的删除
#   - backups/llmwiki/ 下的快照目录：超过 KEEP_DB_DAYS 天的整目录删除
#   - backup.sh 的默认备份根（~/.local/share/llmwiki/backups）：保留最新 RETAIN_COUNT 份
# 用法：
#   ./backup-retention.sh                 # 清理当前用户全部默认位置
#   systemd timer / cron 每日执行
set -euo pipefail

KEEP_CODE="${BACKUP_KEEP_CODE:-2}"
KEEP_DB_DAYS="${BACKUP_KEEP_DB_DAYS:-7}"
RETAIN_COUNT="${BACKUP_RETAIN_COUNT:-7}"
HOME_DIR="${BACKUP_HOME:-$HOME}"

log() { echo "[backup-retention $(date '+%F %T')] $*"; }
freed=0

# deploy-backups：代码包保留最新 KEEP_CODE 份
code_dir="$HOME_DIR/deploy-backups"
if [ -d "$code_dir" ]; then
  while IFS= read -r old; do
    size=$(du -m "$old" 2>/dev/null | cut -f1 || echo 0)
    rm -f "$old"; freed=$((freed + size)); log "removed old code backup: $old (${size}M)"
  done < <(ls -1t "$code_dir"/gbrainkg_code_*.tar.gz 2>/dev/null | tail -n +$((KEEP_CODE + 1)))
  # 库备份：最新 1 份永留，其余按天数过期
  latest_db="$(ls -1t "$code_dir"/llmwiki_*.sql.gz 2>/dev/null | head -1 || true)"
  while IFS= read -r old; do
    [ -n "$latest_db" ] && [ "$old" = "$latest_db" ] && continue
    size=$(du -m "$old" 2>/dev/null | cut -f1 || echo 0)
    rm -f "$old"; freed=$((freed + size)); log "removed expired db backup: $old (${size}M)"
  done < <(find "$code_dir" -maxdepth 1 -name 'llmwiki_*.sql.gz' -type f -mtime +"$KEEP_DB_DAYS" 2>/dev/null)
fi

# backups/llmwiki：过过期快照目录
snap_dir="$HOME_DIR/backups/llmwiki"
if [ -d "$snap_dir" ]; then
  while IFS= read -r old; do
    size=$(du -m "$old" 2>/dev/null | cut -f1 || echo 0)
    rm -rf "$old"; freed=$((freed + size)); log "removed expired snapshot dir: $old (${size}M)"
  done < <(find "$snap_dir" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DB_DAYS" 2>/dev/null)
fi

# backup.sh 默认备份根：与 backup.sh 的 RETAIN_COUNT 对齐
std_dir="$HOME_DIR/.local/share/llmwiki/backups"
if [ -d "$std_dir" ]; then
  ls -1t "$std_dir"/db-*.dump 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm -f
  ls -1t "$std_dir"/files-*.tar.gz 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm -f
fi

log "done. approx freed this run: ${freed}M"
