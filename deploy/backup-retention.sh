#!/usr/bin/env bash
# 备份滚动清理（对所有备份落地位置统一执行保留策略）
# 策略：
#   - 代码备份 gbrainkg_code_*.tar.gz：保留最新 KEEP_CODE 份
#   - 库备份 llmwiki_*.sql.gz：最新 1 份永远保留，其余超过 KEEP_DB_DAYS 天的删除
#   - backups/llmwiki/ 下的快照目录：超过 KEEP_DB_DAYS 天的整目录删除
#   - backup.sh 的默认备份根（~/.local/share/llmwiki/backups 或 BACKUP_ROOT）：
#     db-*.dump / files-*.tar.gz / backup-manifest-*.json 保留最新 RETAIN_COUNT 份
#     basebackup-* 目录 保留最新 BASEBACKUP_KEEP 份（PITR 基线）
#     （BACKUP_RETAIN_COUNT, 默认 7；BACKUP_BASEBACKUP_KEEP, 默认 3）
#     backup-manifest.json 始终保留（指向最新一轮）
#   - WAL 归档（PG_ARCHIVE_DIR, 默认 /data/pg-archive/main）：
#     删除超过 ARCHIVE_KEEP_DAYS 天的段，但绝不删除「最旧保留 basebackup」之后的段
#     （否则剩余 basebackup 无法做完整 PITR）
# 用法：
#   ./backup-retention.sh                 # 清理当前用户全部默认位置
#   BACKUP_RETAIN_COUNT=14 ./backup-retention.sh
#   systemd timer / cron 每日执行
# 生产（meetings2）布局：备份实体位于 /data/backups/{deploy-backups,home-backups}，
# 原路径 ~/deploy-backups、~/backups 为符号链接，本脚本按默认 HOME 路径即可命中。
set -euo pipefail

KEEP_CODE="${BACKUP_KEEP_CODE:-2}"
KEEP_DB_DAYS="${BACKUP_KEEP_DB_DAYS:-7}"
RETAIN_COUNT="${BACKUP_RETAIN_COUNT:-7}"
BASEBACKUP_KEEP="${BACKUP_BASEBACKUP_KEEP:-3}"
ARCHIVE_KEEP_DAYS="${PG_ARCHIVE_KEEP_DAYS:-7}"
PG_ARCHIVE_DIR="${PG_ARCHIVE_DIR:-/data/pg-archive/main}"
HOME_DIR="${BACKUP_HOME:-$HOME}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME_DIR/.local/share/llmwiki/backups}"

log() { echo "[backup-retention $(date '+%F %T')] $*"; }
freed=0

if ! [[ "$RETAIN_COUNT" =~ ^[0-9]+$ ]] || [ "$RETAIN_COUNT" -lt 1 ]; then
  log "ERROR: BACKUP_RETAIN_COUNT must be a positive integer (got: $RETAIN_COUNT)"; exit 2
fi
if ! [[ "$BASEBACKUP_KEEP" =~ ^[0-9]+$ ]] || [ "$BASEBACKUP_KEEP" -lt 1 ]; then
  log "ERROR: BACKUP_BASEBACKUP_KEEP must be a positive integer (got: $BASEBACKUP_KEEP)"; exit 2
fi

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

# backup.sh 默认备份根：与 backup.sh 的 RETAIN_COUNT 对齐，含 manifest 清理
std_dir="$BACKUP_ROOT"
if [ -d "$std_dir" ]; then
  # db-*.dump / files-*.tar.gz：保留最新 RETAIN_COUNT 份
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    size=$(du -m "$old" 2>/dev/null | cut -f1 || echo 0)
    rm -f "$old"; freed=$((freed + size)); log "removed old dump: $old (${size}M)"
  done < <(ls -1t "$std_dir"/db-*.dump 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)))
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    size=$(du -m "$old" 2>/dev/null | cut -f1 || echo 0)
    rm -f "$old"; freed=$((freed + size)); log "removed old files archive: $old (${size}M)"
  done < <(ls -1t "$std_dir"/files-*.tar.gz 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)))
  # backup-manifest-*.json：同样保留最新 RETAIN_COUNT 份；
  # backup-manifest.json 是「最新一轮」指针，永不随滚动删除。
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    case "$(basename "$old")" in
      backup-manifest.json) continue ;;
    esac
    size=$(du -m "$old" 2>/dev/null | cut -f1 || echo 0)
    rm -f "$old"; freed=$((freed + size)); log "removed old manifest: $old (${size}M)"
  done < <(ls -1t "$std_dir"/backup-manifest-*.json 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)))
  # 孤儿 manifest：对应的 dump/files 已被删光的 backup-manifest-*.json
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    base="$(basename "$m")"; stamp="${base#backup-manifest-}"; stamp="${stamp%.json}"
    if [ -n "$stamp" ] && [ ! -e "$std_dir/db-$stamp.dump" ] && [ ! -e "$std_dir/files-$stamp.tar.gz" ] \
       && [ ! -e "$std_dir/basebackup-$stamp" ]; then
      size=$(du -m "$m" 2>/dev/null | cut -f1 || echo 0)
      rm -f "$m"; freed=$((freed + size)); log "removed orphan manifest (artifacts gone): $m"
    fi
  done < <(find "$std_dir" -maxdepth 1 -name 'backup-manifest-*.json' -type f 2>/dev/null)
  # basebackup-* 目录：保留最新 BASEBACKUP_KEEP 份（PITR 基线，删掉即缩短可恢复窗口）
  bb_seen=0
  while IFS= read -r old; do
    [ -n "$old" ] && [ -d "$old" ] || continue
    bb_seen=$((bb_seen + 1))
    if [ "$bb_seen" -gt "$BASEBACKUP_KEEP" ]; then
      size=$(du -sm "$old" 2>/dev/null | cut -f1 || echo 0)
      rm -rf "$old"; freed=$((freed + size)); log "removed old basebackup: $old (${size}M)"
    fi
  done < <(ls -1dt "$std_dir"/basebackup-* 2>/dev/null)
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    size=$(du -m "$old" 2>/dev/null | cut -f1 || echo 0)
    rm -f "$old"; freed=$((freed + size)); log "removed old basebackup manifest: $old (${size}M)"
  done < <(ls -1t "$std_dir"/basebackup-manifest-*.json 2>/dev/null | tail -n +$((BASEBACKUP_KEEP + 1)))
fi

# WAL 归档清理：按天数，但绝不删「最旧保留 basebackup」时间点之后的段
# （否则剩余 basebackup 无法恢复到其备份时刻之后的任意点）
if [ -d "$PG_ARCHIVE_DIR" ]; then
  # 最旧保留 basebackup 的 mtime 作为保护下界；无 basebackup 则只按天数
  horizon=0
  for bb in "$BACKUP_ROOT"/basebackup-*; do
    [ -d "$bb" ] || continue
    mt=$(stat -c %Y "$bb" 2>/dev/null || echo 0)
    if [ "$mt" -gt 0 ] && { [ "$horizon" -eq 0 ] || [ "$mt" -lt "$horizon" ]; }; then
      horizon=$mt
    fi
  done
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    mt=$(stat -c %Y "$seg" 2>/dev/null || echo 0)
    # 超龄
    if find "$seg" -maxdepth 0 -mtime +"$ARCHIVE_KEEP_DAYS" 2>/dev/null | grep -q .; then
      : # old enough by age
    else
      continue
    fi
    # 保护: basebackup 之后的段不删
    if [ "$horizon" -gt 0 ] && [ "$mt" -ge "$horizon" ]; then
      continue
    fi
    size=$(du -m "$seg" 2>/dev/null | cut -f1 || echo 0)
    rm -f "$seg"; freed=$((freed + size)); log "removed expired WAL segment: $seg (${size}M)"
  done < <(find "$PG_ARCHIVE_DIR" -maxdepth 1 -type f \( -name '[0-9A-F]*' -o -name '*.partial' \) 2>/dev/null)
fi

log "done. approx freed this run: ${freed}M (retain=$RETAIN_COUNT, basebackup_keep=$BASEBACKUP_KEEP, root=$std_dir, archive=$PG_ARCHIVE_DIR)"
