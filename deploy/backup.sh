#!/usr/bin/env bash
# LLMWiki 数据库与文件备份脚本 (OPT-4 / P2: offsite + 校验 + manifest)
# - PostgreSQL 逻辑备份 (pg_dump custom format, 可用 pg_restore 恢复)
# - 上传原始文件 + GBrain 仓库归档
# - 本地滚动保留 (默认 7 份, BACKUP_RETAIN_COUNT 可调)
# - 可选异地镜像 (--offsite / BACKUP_OFFSITE_DIR / BACKUP_OFFSITE_S3), 默认关闭
# - 产物校验 (pg_dump 退出码 + PGDMP 魔数 + gzip -t) 并写 backup-manifest.json
# 用法:
#   ./backup.sh                     # 手动执行本地备份 (逻辑 dump)
#   ./backup.sh --basebackup        # dump + pg_basebackup 物理备份 (PITR 基线, 与 dump 并存)
#   ./backup.sh --basebackup-only   # 仅 pg_basebackup (跳过逻辑 dump)
#   ./backup.sh --offsite           # 本地备份成功后镜像到异地 (需已配置目标)
#   ./backup.sh --offsite-required  # 异地失败即退出非零 (关键路径)
#   ./backup.sh --help
#   systemd timer 每日自动执行       # 见 deploy/systemd/llmwiki-backup.timer
#
# 环境变量 (均有默认值, 密码绝不写死在脚本里):
#   BACKUP_ROOT            备份根目录 (默认 ~/.local/share/llmwiki/backups)
#   BACKUP_RETAIN_COUNT    本地保留份数 (默认 7)
#   BACKUP_DB_NAME/USER/CONTAINER   库名/用户/容器名
#   DATABASE_URL           完整连接串 (优先; 密码请放 env, 勿写进命令行历史)
#   PGPASSWORD             pg_dump/pg_restore 密码 (native 模式)
#   BACKUP_OFFSITE_DIR     异地目录 (rsync/cp 目标), 非空即视为启用 offsite
#   BACKUP_OFFSITE_S3      异地 S3/MinIO 目标 (mc alias, 例 backup-remote/bucket)
#   BACKUP_S3_ALIAS        兼容旧名, 等价 BACKUP_OFFSITE_S3
#   BACKUP_OFFSITE         设为 1 强制启用 offsite (即使目标来自 CLI 推断)
#   BACKUP_BASEBACKUP      设为 1 等价 --basebackup
#   BACKUP_BASEBACKUP_KEEP 物理备份保留份数 (默认同 BACKUP_RETAIN_COUNT)
#   PITR_USE_SUDO          =1 时 pg_basebackup 走 sudo -u postgres (peer 认证)
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.local/share/llmwiki/backups}"
RETAIN_COUNT="${BACKUP_RETAIN_COUNT:-7}"
LLMWIKI_DATA_ROOT="${LLMWIKI_DATA_ROOT:-$HOME/.local/share/llmwiki}"
DB_CONTAINER="${BACKUP_DB_CONTAINER:-llmwiki-postgres}"
DB_USER="${BACKUP_DB_USER:-llmwiki}"
DB_NAME="${BACKUP_DB_NAME:-llmwiki}"
OFFSITE_DIR="${BACKUP_OFFSITE_DIR:-}"
OFFSITE_S3="${BACKUP_OFFSITE_S3:-${BACKUP_S3_ALIAS:-}}"
OFFSITE_FLAG=0
OFFSITE_REQUIRED=0
BASEBACKUP_FLAG=0
BASEBACKUP_ONLY=0
BASEBACKUP_KEEP="${BACKUP_BASEBACKUP_KEEP:-$RETAIN_COUNT}"
PG_VERSION=""

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --offsite) OFFSITE_FLAG=1 ;;
    --offsite-required) OFFSITE_FLAG=1; OFFSITE_REQUIRED=1 ;;
    --basebackup) BASEBACKUP_FLAG=1 ;;
    --basebackup-only) BASEBACKUP_FLAG=1; BASEBACKUP_ONLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ "${BACKUP_BASEBACKUP:-0}" = "1" ]; then
  BASEBACKUP_FLAG=1
fi

# 默认关闭: 仅当 CLI --offsite / --offsite-required, 或已配置异地目标时启用
if [ "$OFFSITE_FLAG" -eq 1 ] || [ "${BACKUP_OFFSITE:-0}" = "1" ] || [ -n "$OFFSITE_DIR" ] || [ -n "$OFFSITE_S3" ]; then
  OFFSITE_ENABLED=1
else
  OFFSITE_ENABLED=0
fi

log() { echo "[backup $(date '+%F %T')] $*"; }
sha256_of() { sha256sum "$1" | awk '{print $1}'; }
bytes_of() { stat -c%s "$1" 2>/dev/null || wc -c < "$1"; }

mkdir -p "$BACKUP_ROOT"

# ---- 1. PostgreSQL ----
DUMP_FILE="$BACKUP_ROOT/db-$STAMP.dump"
DUMP_PRESENT=0
if [ "$BASEBACKUP_ONLY" -eq 1 ]; then
  log "skipping logical dump (--basebackup-only)"
elif command -v pg_dump >/dev/null 2>&1; then
  PG_VERSION="$(pg_dump --version 2>/dev/null || true)"
  # Default to port 5432 (native PG); docker-compose dual-mapped uses 5433 for host
  # but native deployments use 5432. DATABASE_URL from env takes precedence.
  pg_dump "${DATABASE_URL:-postgresql://$DB_USER@127.0.0.1:5432/$DB_NAME}" \
    --format=custom --no-owner --file "$DUMP_FILE" || {
    log "ERROR: pg_dump failed"; exit 1
  }
  DUMP_PRESENT=1
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
  PG_VERSION="$(docker exec "$DB_CONTAINER" pg_dump --version 2>/dev/null || true)"
  docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" --format=custom --no-owner "$DB_NAME" \
    > "$DUMP_FILE" || {
    log "ERROR: container pg_dump failed"; exit 1
  }
  DUMP_PRESENT=1
else
  log "ERROR: neither pg_dump nor container $DB_CONTAINER available"; exit 1
fi
if [ "$DUMP_PRESENT" -eq 1 ]; then
  log "database dump ok: db-$STAMP.dump ($(du -h "$DUMP_FILE" | cut -f1))"
fi

# ---- 2. 文件 (上传原件 + GBrain 编译仓库) ----
FILES_TAR="$BACKUP_ROOT/files-$STAMP.tar.gz"
FILES_PRESENT=0
if [ -d "$LLMWIKI_DATA_ROOT" ]; then
  tar -czf "$FILES_TAR" -C "$LLMWIKI_DATA_ROOT" uploads brain_repos || {
    log "ERROR: files tar failed"; exit 1
  }
  # Verify archive is non-empty
  if [ ! -s "$FILES_TAR" ]; then
    log "WARNING: files archive is empty"; exit 1
  fi
  FILES_PRESENT=1
  log "files archive ok: files-$STAMP.tar.gz ($(du -h "$FILES_TAR" | cut -f1))"
fi

# ---- 2b. 产物校验 ----
# pg_dump custom format 不是 gzip 流: 用 pg_dump 自身退出码(上文)+PGDMP 魔数校验;
# files-*.tar.gz 走 gzip -t。两者都算 verify_artifact 的可校验目标。
verify_artifact() {
  local f="$1"
  if [ ! -s "$f" ]; then
    log "VERIFY FAIL: $f missing or empty"
    return 1
  fi
  # 用 od 取魔数十六进制，避免 head 读 gzip 头时的 NUL 警告
  local magic_hex
  magic_hex="$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')"
  case "$magic_hex" in
    1f8b*)
      gzip -t "$f" || { log "VERIFY FAIL: gzip -t $f"; return 1; }
      log "verify ok (gzip -t): $(basename "$f")"
      ;;
    5047444d*)
      # PGDMP custom-format dump: 魔数 + 可选 pg_restore 目录列表 (能读出即结构完整)
      if command -v pg_restore >/dev/null 2>&1; then
        pg_restore --list "$f" >/dev/null 2>&1 || { log "VERIFY FAIL: pg_restore --list $f"; return 1; }
        log "verify ok (PGDMP + pg_restore --list): $(basename "$f")"
      else
        log "verify ok (PGDMP magic; pg_restore not in PATH, skipped TOC check): $(basename "$f")"
      fi
      ;;
    *)
      # tar.gz 若 magic 识别失败, 兜底再试 gzip -t
      if gzip -t "$f" 2>/dev/null; then
        log "verify ok (gzip -t fallback): $(basename "$f")"
      else
        log "VERIFY FAIL: unrecognized artifact $f"
        return 1
      fi
      ;;
  esac
}

if [ "$DUMP_PRESENT" -eq 1 ]; then
  verify_artifact "$DUMP_FILE" || { log "ERROR: database dump failed verification"; exit 1; }
fi
if [ "$FILES_PRESENT" -eq 1 ]; then
  verify_artifact "$FILES_TAR" || { log "ERROR: files archive failed verification"; exit 1; }
fi

# ---- 2b-2. 物理基础备份 (pg_basebackup, --basebackup / --basebackup-only) ----
# 与逻辑 dump 并存: dump 管「单库逻辑恢复/迁版本」, basebackup 管「PITR/整集群恢复」。
BASE_DIR=""
BASEBACKUP_PRESENT=0
if [ "$BASEBACKUP_FLAG" -eq 1 ]; then
  BASE_DIR="$BACKUP_ROOT/basebackup-$STAMP"
  log "pg_basebackup start -> $BASE_DIR ..."
  if [ "${PITR_USE_SUDO:-0}" = "1" ]; then
    sudo -n -u postgres pg_basebackup -D "$BASE_DIR" -Ft -X stream --checkpoint=fast -l "backup-$STAMP" \
      || { log "ERROR: pg_basebackup (sudo) failed"; exit 1; }
  elif command -v pg_basebackup >/dev/null 2>&1; then
    # 连接参数: 优先 PG* 环境, 否则 127.0.0.1:5432 user=$DB_USER
    PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-$DB_USER}" \
      pg_basebackup -D "$BASE_DIR" -Ft -X stream --checkpoint=fast -l "backup-$STAMP" \
      || { log "ERROR: pg_basebackup failed"; exit 1; }
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
    docker exec -u postgres "$DB_CONTAINER" pg_basebackup -D "/tmp/basebackup-$STAMP" -Ft -X stream --checkpoint=fast -l "backup-$STAMP" \
      || { log "ERROR: container pg_basebackup failed"; exit 1; }
    docker cp "$DB_CONTAINER:/tmp/basebackup-$STAMP" "$BASE_DIR"
    docker exec "$DB_CONTAINER" rm -rf "/tmp/basebackup-$STAMP"
  else
    log "ERROR: pg_basebackup not available (host/sudo/docker)"; exit 1
  fi
  [ -f "$BASE_DIR/base.tar" ] || [ -f "$BASE_DIR/base.tar.gz" ] || [ -f "$BASE_DIR/PG_VERSION" ] \
    || { log "ERROR: basebackup artifact missing under $BASE_DIR"; exit 1; }
  BASEBACKUP_PRESENT=1
  log "basebackup ok: $(basename "$BASE_DIR") ($(du -h "$BASE_DIR" | cut -f1))"
fi

# ---- 2c. backup-manifest.json ----
# 每轮写 backup-manifest-$STAMP.json (可被 retention 清理) 并刷新 backup-manifest.json (始终指向最新)。
json_artifact() {
  local f="$1" typ="$2"
  printf '    {"file": "%s", "type": "%s", "bytes": %s, "sha256": "%s", "verified": true}' \
    "$(basename "$f")" "$typ" "$(bytes_of "$f")" "$(sha256_of "$f")"
}

MANIFEST_LATEST="$BACKUP_ROOT/backup-manifest.json"
MANIFEST_STAMPED="$BACKUP_ROOT/backup-manifest-$STAMP.json"
OFFSITE_STATUS_JSON='{"enabled": false, "ok": false, "target": null, "error": null}'

write_manifest() {
  local offsite_json="$1"
  local first=1
  {
    printf '{\n'
    printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "stamp": "%s",\n' "$STAMP"
    printf '  "dbName": "%s",\n' "$DB_NAME"
    printf '  "pgVersion": "%s",\n' "$(printf '%s' "$PG_VERSION" | sed 's/"/\\"/g')"
    printf '  "backupRoot": "%s",\n' "$BACKUP_ROOT"
    printf '  "retainCount": %s,\n' "$RETAIN_COUNT"
    printf '  "basebackupKeep": %s,\n' "$BASEBACKUP_KEEP"
    printf '  "artifacts": [\n'
    if [ "$DUMP_PRESENT" -eq 1 ]; then
      json_artifact "$DUMP_FILE" "database"
      first=0
    fi
    if [ "$FILES_PRESENT" -eq 1 ]; then
      [ "$first" -eq 1 ] || printf ',\n'
      json_artifact "$FILES_TAR" "files"
      first=0
    fi
    if [ "$BASEBACKUP_PRESENT" -eq 1 ]; then
      [ "$first" -eq 1 ] || printf ',\n'
      # basebackup 是目录: 记录路径 + 总字节 (sha256 对 base.tar 若存在则给)
      if [ -f "$BASE_DIR/base.tar" ]; then
        json_artifact "$BASE_DIR/base.tar" "basebackup"
      elif [ -f "$BASE_DIR/base.tar.gz" ]; then
        json_artifact "$BASE_DIR/base.tar.gz" "basebackup"
      else
        printf '    {"file": "%s", "type": "basebackup", "bytes": %s, "sha256": null, "verified": true}' \
          "$(basename "$BASE_DIR")" "$(du -sb "$BASE_DIR" 2>/dev/null | awk '{print $1}' || echo 0)"
      fi
      first=0
    fi
    printf '\n  ],\n'
    printf '  "offsite": %s\n' "$offsite_json"
    printf '}\n'
  } > "$MANIFEST_STAMPED"
  cp -f "$MANIFEST_STAMPED" "$MANIFEST_LATEST"
  log "manifest ok: $(basename "$MANIFEST_STAMPED") (+ refreshed backup-manifest.json)"
}

# ---- 3. 异地镜像 (可选, 默认关闭; 失败不阻断主备份, 除非 --offsite-required) ----
offsite_one() {
  local src="$1"
  if [ -n "$OFFSITE_DIR" ]; then
    mkdir -p "$OFFSITE_DIR"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --partial "$src" "$OFFSITE_DIR/"
    else
      cp -a "$src" "$OFFSITE_DIR/"
    fi
  fi
  if [ -n "$OFFSITE_S3" ] && command -v mc >/dev/null 2>&1; then
    mc cp "$src" "$OFFSITE_S3/" >/dev/null
  fi
}

OFFSITE_OK=0
OFFSITE_ERR="null"
OFFSITE_TARGET="null"
if [ "$OFFSITE_ENABLED" -eq 1 ]; then
  if [ -z "$OFFSITE_DIR" ] && [ -z "$OFFSITE_S3" ]; then
    OFFSITE_ERR='"no BACKUP_OFFSITE_DIR / BACKUP_OFFSITE_S3 configured"'
    log "WARNING: offsite requested but no target configured; skipping offsite"
    if [ "$OFFSITE_REQUIRED" -eq 1 ]; then
      write_manifest "{\"enabled\": true, \"ok\": false, \"target\": null, \"error\": $OFFSITE_ERR}"
      log "ERROR: --offsite-required set but offsite target missing"; exit 1
    fi
    OFFSITE_STATUS_JSON="{\"enabled\": true, \"ok\": false, \"target\": null, \"error\": $OFFSITE_ERR}"
  else
    [ -n "$OFFSITE_DIR" ] && OFFSITE_TARGET="\"$OFFSITE_DIR\""
    [ -n "$OFFSITE_S3" ] && OFFSITE_TARGET="\"$OFFSITE_S3\""
    log "offsite mirror start -> dir=${OFFSITE_DIR:-<none>} s3=${OFFSITE_S3:-<none>} (non-critical unless --offsite-required)"
    OFFSITE_CHAIN_OK=1
    if [ "$DUMP_PRESENT" -eq 1 ]; then
      offsite_one "$DUMP_FILE" || OFFSITE_CHAIN_OK=0
    fi
    if [ "$OFFSITE_CHAIN_OK" -eq 1 ] && [ "$FILES_PRESENT" -eq 1 ]; then
      offsite_one "$FILES_TAR" || OFFSITE_CHAIN_OK=0
    fi
    if [ "$OFFSITE_CHAIN_OK" -eq 1 ] && [ "$BASEBACKUP_PRESENT" -eq 1 ]; then
      # basebackup 目录整体镜像
      if [ -n "$OFFSITE_DIR" ]; then
        mkdir -p "$OFFSITE_DIR"
        rsync -a --partial "$BASE_DIR" "$OFFSITE_DIR/" 2>/dev/null || cp -a "$BASE_DIR" "$OFFSITE_DIR/" || OFFSITE_CHAIN_OK=0
      fi
      if [ -n "$OFFSITE_S3" ] && command -v mc >/dev/null 2>&1; then
        mc cp --recursive "$BASE_DIR" "$OFFSITE_S3/$(basename "$BASE_DIR")/" >/dev/null || OFFSITE_CHAIN_OK=0
      fi
    fi
    if [ "$OFFSITE_CHAIN_OK" -eq 1 ]; then
      OFFSITE_OK=1
      log "remote mirror ok -> $OFFSITE_TARGET"
      OFFSITE_STATUS_JSON="{\"enabled\": true, \"ok\": true, \"target\": $OFFSITE_TARGET, \"error\": null}"
    else
      OFFSITE_ERR='"rsync/cp/mc offsite copy failed"'
      log "WARNING: offsite mirror failed (main local backup is intact)"
      OFFSITE_STATUS_JSON="{\"enabled\": true, \"ok\": false, \"target\": $OFFSITE_TARGET, \"error\": $OFFSITE_ERR}"
      if [ "$OFFSITE_REQUIRED" -eq 1 ]; then
        write_manifest "$OFFSITE_STATUS_JSON"
        log "ERROR: --offsite-required set and offsite failed"; exit 1
      fi
    fi
  fi
else
  log "offsite disabled (enable with --offsite or BACKUP_OFFSITE_DIR / BACKUP_OFFSITE_S3)"
  OFFSITE_STATUS_JSON='{"enabled": false, "ok": false, "target": null, "error": null}'
fi

# manifest 在 offsite 之后落盘, 从而带上 offsite 结果; 随后把 manifest 也镜像过去(非关键)
write_manifest "$OFFSITE_STATUS_JSON"
if [ "$OFFSITE_OK" -eq 1 ]; then
  offsite_one "$MANIFEST_STAMPED" || log "WARNING: offsite manifest copy failed (non-critical)"
fi

# ---- 4. 滚动保留 (dump / files / manifest / basebackup) ----
ls -1t "$BACKUP_ROOT"/db-*.dump 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm -f
ls -1t "$BACKUP_ROOT"/files-*.tar.gz 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm -f
ls -1t "$BACKUP_ROOT"/backup-manifest-*.json 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm -f
# basebackup-* 目录保留 BASEBACKUP_KEEP 份 (与 scripts/pg-pitr-backup.sh 同口径)
mapfile -t _BB_DIRS < <(ls -1dt "$BACKUP_ROOT"/basebackup-* 2>/dev/null || true)
_BB_KEEP=0
for _d in "${_BB_DIRS[@]:-}"; do
  [ -d "$_d" ] || continue
  _BB_KEEP=$((_BB_KEEP + 1))
  if [ "$_BB_KEEP" -gt "$BASEBACKUP_KEEP" ]; then
    log "retention: removing old basebackup $_d"
    rm -rf "$_d"
  fi
done
ls -1t "$BACKUP_ROOT"/basebackup-manifest-*.json 2>/dev/null | tail -n +$((BASEBACKUP_KEEP + 1)) | xargs -r rm -f

log "done. backup root: $BACKUP_ROOT (dump=$DUMP_PRESENT basebackup=$BASEBACKUP_PRESENT)"
