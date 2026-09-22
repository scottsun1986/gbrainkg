#!/usr/bin/env bash
# 备份状态一览：最近备份时间、大小、是否 offsite、预计 RPO。
# 无备份时优雅报告 "无备份" 并退出 0（不崩溃）。
# 用法:
#   ./backup-status.sh
#   BACKUP_ROOT=/path/to/backups ./backup-status.sh
# 环境变量:
#   BACKUP_ROOT          备份根 (默认 ~/.local/share/llmwiki/backups)
#   BACKUP_RETAIN_COUNT  保留份数 (仅展示, 默认 7)
#   BACKUP_RPO_TARGET_S  RPO 目标秒数 (默认 86400 = 24h), 超标时标记 WARNING
set -uo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.local/share/llmwiki/backups}"
RETAIN_COUNT="${BACKUP_RETAIN_COUNT:-7}"
RPO_TARGET_S="${BACKUP_RPO_TARGET_S:-86400}"

log() { echo "[backup-status $(date '+%F %T')] $*"; }

human_age() {
  local sec="$1"
  if [ "$sec" -lt 60 ]; then echo "${sec}s"
  elif [ "$sec" -lt 3600 ]; then echo "$((sec / 60))m $((sec % 60))s"
  elif [ "$sec" -lt 86400 ]; then echo "$((sec / 3600))h $(((sec % 3600) / 60))m"
  else echo "$((sec / 86400))d $(((sec % 86400) / 3600))h"
  fi
}

human_size() {
  local f="$1"
  du -h "$f" 2>/dev/null | cut -f1 || echo "?"
}

if [ ! -d "$BACKUP_ROOT" ]; then
  log "无备份 (no backups): backup root does not exist: $BACKUP_ROOT"
  exit 0
fi

LATEST_DUMP="$(ls -1t "$BACKUP_ROOT"/db-*.dump 2>/dev/null | head -1 || true)"
LATEST_FILES="$(ls -1t "$BACKUP_ROOT"/files-*.tar.gz 2>/dev/null | head -1 || true)"
LATEST_MANIFEST="$(ls -1t "$BACKUP_ROOT"/backup-manifest*.json 2>/dev/null | head -1 || true)"

if [ -z "$LATEST_DUMP" ] && [ -z "$LATEST_FILES" ]; then
  log "无备份 (no backups): $BACKUP_ROOT has no db-*.dump / files-*.tar.gz"
  exit 0
fi

# 以最新 dump（或 files）的 mtime 作为「最近备份时间」
REF="${LATEST_DUMP:-$LATEST_FILES}"
NOW="$(date +%s)"
MTIME="$(stat -c %Y "$REF" 2>/dev/null || echo "$NOW")"
AGE_S=$((NOW - MTIME))
HUMAN_TIME="$(date -d "@$MTIME" '+%F %T %z' 2>/dev/null || date -r "$MTIME" '+%F %T %z' 2>/dev/null || echo "mtime=$MTIME")"

echo "=================================================="
echo "  LLMWiki backup status"
echo "=================================================="
echo "  backup root     : $BACKUP_ROOT"
echo "  retain count    : $RETAIN_COUNT (BACKUP_RETAIN_COUNT)"
echo "  last backup at  : $HUMAN_TIME"
echo "  backup age      : $(human_age "$AGE_S")"
echo ""

if [ -n "$LATEST_DUMP" ]; then
  echo "  latest dump     : $(basename "$LATEST_DUMP") ($(human_size "$LATEST_DUMP"))"
else
  echo "  latest dump     : (none)"
fi
if [ -n "$LATEST_FILES" ]; then
  echo "  latest files    : $(basename "$LATEST_FILES") ($(human_size "$LATEST_FILES"))"
else
  echo "  latest files    : (none)"
fi
echo ""

# manifest：offsite / sha256 / pg 版本
OFFSITE_LINE="unknown (no manifest)"
RPO_NOTE=""
if [ -n "$LATEST_MANIFEST" ] && command -v jq >/dev/null 2>&1; then
  GEN_AT="$(jq -r '.generatedAt // empty' "$LATEST_MANIFEST" 2>/dev/null || true)"
  PG_VER="$(jq -r '.pgVersion // empty' "$LATEST_MANIFEST" 2>/dev/null || true)"
  OFF_EN="$(jq -r '.offsite.enabled // false' "$LATEST_MANIFEST" 2>/dev/null || true)"
  OFF_OK="$(jq -r '.offsite.ok // false' "$LATEST_MANIFEST" 2>/dev/null || true)"
  OFF_TGT="$(jq -r '.offsite.target // empty' "$LATEST_MANIFEST" 2>/dev/null || true)"
  OFF_ERR="$(jq -r '.offsite.error // empty' "$LATEST_MANIFEST" 2>/dev/null || true)"
  if [ "$OFF_EN" = "true" ]; then
    if [ "$OFF_OK" = "true" ]; then
      OFFSITE_LINE="YES (ok) -> ${OFF_TGT:-?}"
    else
      OFFSITE_LINE="YES (FAILED) -> ${OFF_TGT:-?}${OFF_ERR:+ err=$OFF_ERR}"
    fi
  else
    OFFSITE_LINE="NO (disabled; set BACKUP_OFFSITE_DIR or pass --offsite)"
  fi
  echo "  manifest        : $(basename "$LATEST_MANIFEST")${GEN_AT:+ (generatedAt=$GEN_AT)}"
  echo "  pg version      : ${PG_VER:-unknown}"
else
  echo "  manifest        : ${LATEST_MANIFEST:-none}${LATEST_MANIFEST:+ (jq missing or unreadable)}"
fi
echo "  offsite         : $OFFSITE_LINE"
echo ""

# 预计 RPO = 备份新鲜度 = 若此刻灾难丢失生产库, 最多回退的数据时间窗 = 备份年龄
# （目标 RPO 另行评估, 见 deploy/restore-drill.md）
RPO_HUMAN="$(human_age "$AGE_S")"
echo "  estimated RPO   : $RPO_HUMAN  (window = age of last backup)"
if [ "$AGE_S" -gt "$RPO_TARGET_S" ]; then
  echo "  RPO verdict     : WARNING — older than target ${RPO_TARGET_S}s (BACKUP_RPO_TARGET_S)"
  log "RPO WARNING: last backup age $(human_age "$AGE_S") exceeds target $(human_age "$RPO_TARGET_S")"
else
  echo "  RPO verdict     : OK — within target $(human_age "$RPO_TARGET_S")"
fi

# 最近几份一览
echo ""
echo "  recent backups (newest first, max 5):"
ls -1t "$BACKUP_ROOT"/db-*.dump 2>/dev/null | head -5 | while IFS= read -r f; do
  ts="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
  when="$(date -d "@$ts" '+%F %T' 2>/dev/null || echo "?")"
  printf '    %s  %8s  %s\n' "$when" "$(human_size "$f")" "$(basename "$f")"
done
COUNT_DB="$(ls -1 "$BACKUP_ROOT"/db-*.dump 2>/dev/null | wc -l | tr -d ' ')"
COUNT_FILES="$(ls -1 "$BACKUP_ROOT"/files-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')"
echo ""
echo "  totals          : ${COUNT_DB:-0} dump(s), ${COUNT_FILES:-0} files archive(s)"
echo "=================================================="
exit 0
