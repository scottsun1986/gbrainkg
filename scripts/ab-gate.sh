#!/usr/bin/env bash
# A/B 指标回流门禁：对比 control/treatment，treatment 显著劣化即失败。
#
# 用法:
#   bash scripts/ab-gate.sh                     # 无凭据则跳过(退出 2)
#   GATE_STRICT=1 bash scripts/ab-gate.sh       # 缺凭据/数据/服务异常均非零
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
  if [ "$STRICT" = "1" ]; then
    log "FAIL: strict mode requires live A/B validation credentials."
    exit 1
  fi
  exit 2
fi

export TEST_USER TEST_PASSWORD
npx --yes tsx@4.23.13 tests/evaluation/ab-gate-runner.ts
rc=$?

if [ "$rc" -ne 0 ]; then
  log "FAIL: evaluation runner exited $rc"
elif [ "$STRICT" = "1" ]; then
  log "PASS: strict quality gate"
else
  log "Report completed; strict quality thresholds were not requested."
fi
exit "$rc"
