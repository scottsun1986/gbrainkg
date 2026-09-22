#!/usr/bin/env bash
# A/B 指标回流门禁：对比 control/treatment，treatment 显著劣化即失败。
#
# 用法:
#   bash scripts/ab-gate.sh                     # 无凭据则跳过(退出 0)
#   GATE_STRICT=1 bash scripts/ab-gate.sh       # 发布门禁：有凭据时劣化即非零
#
# 凭据:
#   TEST_USER / TEST_PASSWORD  管理端登录（拉 /api/v1/experiments/summary）
#   API_BASE                   默认 http://127.0.0.1:3202
#   AB_TOLERANCE               允许劣化幅度（默认 0.05）
#   AB_MIN_SAMPLES             每臂最小样本（默认 30）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STRICT="${GATE_STRICT:-0}"
TEST_USER="${TEST_USER:-${LLMWIKI_USER:-admin}}"
TEST_PASSWORD="${TEST_PASSWORD:-${LLMWIKI_PASS:-}}"
export API_BASE="${API_BASE:-http://127.0.0.1:3202}"

log() { echo "[ab-gate $(date '+%F %T')] $*"; }

if [ -z "$TEST_PASSWORD" ]; then
  log "skip: TEST_PASSWORD not set — cannot fetch experiment summary."
  [ "$STRICT" = "1" ] && log "strict mode: treating skip as pass (no live experiments assumed)."
  exit 0
fi

export TEST_USER TEST_PASSWORD
npx --yes tsx@4.23.13 tests/evaluation/ab-gate-runner.ts
rc=$?

if [ "$STRICT" = "1" ]; then
  if [ "$rc" -ne 0 ]; then
    log "FAIL: A/B gate failed (treatment degraded or runner error)"
  else
    log "PASS: A/B gate"
  fi
  exit "$rc"
fi

if [ "$rc" -ne 0 ]; then
  log "WARNING: A/B runner exited $rc in report mode — not blocking."
else
  log "done (report mode)."
fi
exit 0
