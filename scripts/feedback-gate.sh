#!/usr/bin/env bash
# 反馈回流发布门禁 (P2 feedback regression gate)
# 调用 tests/evaluation/feedback-regression.ts：把管理员 converted 的 FeedbackCase
# 重放回线上问答，校验拒答 / 关键词缺失 / 与旧答案完全相同 三类回归。
#
# 用法:
#   bash scripts/feedback-gate.sh                  # 有凭据则跑，无凭据则跳过(退出 2)
#   GATE_STRICT=1 bash scripts/feedback-gate.sh    # 发布门禁：有凭据时回归即非零退出
#
# 凭据（从 env 读，不写死；与 tests/evaluation/feedback-regression.ts 对齐）:
#   LLMWIKI_TOKEN     CI 常用令牌；本 gate 用它判断「已配置 token」
#   TEST_USER         管理端用户名（默认 admin；也可用 LLMWIKI_USER）
#   TEST_PASSWORD     管理端密码（harness 登录用；也可用 LLMWIKI_PASS）
#   API_BASE          默认 http://127.0.0.1:3202
#   GATE_STRICT       =1 且配置了 token 时，回归/执行失败即退出非零
#   FEEDBACK_REPORT   可选，报告落盘路径
#   FEEDBACK_LIMIT    可选，重放条数上限（默认 50）
#
# 行为矩阵:
#   无 LLMWIKI_TOKEN 且无 TEST_PASSWORD  -> 跳过 + 警告，退出 2
#   有 token 但缺 TEST_PASSWORD           -> GATE_STRICT=1 则非零；否则跳过 + 警告，退出 2
#   有凭据，GATE_STRICT!=1                -> 报告模式（FEEDBACK_GATE 不开），仅执行报告；执行错误仍非零
#   有凭据，GATE_STRICT=1                 -> FEEDBACK_GATE=1，harness 失败即非零
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STRICT="${GATE_STRICT:-0}"
TOKEN="${LLMWIKI_TOKEN:-}"
TEST_USER="${TEST_USER:-${LLMWIKI_USER:-admin}}"
TEST_PASSWORD="${TEST_PASSWORD:-${LLMWIKI_PASS:-}}"
export TEST_USER
export API_BASE="${API_BASE:-http://127.0.0.1:3202}"

log() { echo "[feedback-gate $(date '+%F %T')] $*"; }
warn() { log "WARNING: $*"; }

# ---- 无 token/凭据：跳过并警告，退出 2（不要求本地必须有线上凭据）----
if [ -z "$TOKEN" ] && [ -z "$TEST_PASSWORD" ]; then
  warn "skip: no LLMWIKI_TOKEN / TEST_PASSWORD configured — feedback regression gate not run."
  warn "set LLMWIKI_TOKEN (for CI bookkeeping) and TEST_PASSWORD (admin login for the harness) to enable."
  if [ "$STRICT" = "1" ]; then
    log "FAIL: strict mode requires feedback regression credentials."
    exit 1
  fi
  exit 2
fi

# harness 需要管理端密码登录；仅有 bearer token 跑不了 feedback-regression.ts
if [ -z "$TEST_PASSWORD" ]; then
  if [ "$STRICT" = "1" ]; then
    log "ERROR: GATE_STRICT=1 and LLMWIKI_TOKEN is set, but TEST_PASSWORD (or LLMWIKI_PASS) is missing."
    log "feedback-regression.ts authenticates via admin login; provide TEST_PASSWORD."
    exit 1
  fi
  warn "skip: LLMWIKI_TOKEN present but TEST_PASSWORD missing (harness logs in with admin password)."
  exit 2
fi

export TEST_PASSWORD
[ -n "$TOKEN" ] && export LLMWIKI_TOKEN="$TOKEN"

# GATE_STRICT=1 且配置了 token/凭据：把回归失败升级为非零退出（FEEDBACK_GATE=1）
if [ "$STRICT" = "1" ]; then
  export FEEDBACK_GATE=1
  log "strict mode: FEEDBACK_GATE=1 (regression => non-zero exit)"
else
  # 报告模式：仍执行并打印，但不因回归失败而阻断
  unset FEEDBACK_GATE 2>/dev/null || true
  log "report mode (set GATE_STRICT=1 for release-blocking behaviour)"
fi

log "running tests/evaluation/feedback-regression.ts against $API_BASE (user=$TEST_USER) ..."
# 与 package.json 的 evaluate:feedback 同一套调用方式
npx --yes tsx@4.23.13 tests/evaluation/feedback-regression.ts
rc=$?

if [ "$rc" -ne 0 ]; then
  log "FAIL: evaluation runner exited $rc"
elif [ "$STRICT" = "1" ]; then
  log "PASS: strict quality gate"
else
  log "Report completed; strict quality thresholds were not requested."
fi
exit "$rc"
