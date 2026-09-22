#!/usr/bin/env bash
# ==============================================================================
# GBrainKG 一键回滚脚本（运维手动执行入口）
# ==============================================================================
# 用法:
#   bash scripts/rollback-release.sh                          # 回滚到上一个发布快照 (previous)
#   bash scripts/rollback-release.sh previous --target=inst1  # 回滚实例1到上一个快照
#   bash scripts/rollback-release.sh 20260922120000 --target=inst2
#   bash scripts/rollback-release.sh --list --target=inst1    # 仅列出可用快照
#
# 实现说明: 委托给 scripts/deploy-prod.sh --rollback，保证回滚逻辑只有一份。
# 快照由 deploy-prod.sh 在每次发布前写入 $PROD_REPO/.releases/<timestamp>/。
# 本脚本不会自动执行生产部署，只做「回切代码 + 重启 + 健康检查」。
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REF=""
PASSTHRU=()
LIST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,14p' "$ROOT/scripts/rollback-release.sh" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --list) LIST_ONLY=true ;;
    --target=*|inst*|--inst*|all|--all) PASSTHRU+=("$arg") ;;
    previous|latest|[0-9]*) REF="$arg" ;;
    *)
      echo "Unknown argument: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

if [[ "$LIST_ONLY" == true ]]; then
  exec bash "$ROOT/scripts/deploy-prod.sh" --rollback=list ${PASSTHRU[@]+"${PASSTHRU[@]}"}
fi

if [[ -n "$REF" ]]; then
  exec bash "$ROOT/scripts/deploy-prod.sh" --rollback "$REF" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
else
  exec bash "$ROOT/scripts/deploy-prod.sh" --rollback previous ${PASSTHRU[@]+"${PASSTHRU[@]}"}
fi
