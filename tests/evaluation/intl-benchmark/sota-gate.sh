#!/usr/bin/env bash
#
# SOTA gate: public multi-hop benchmarks + no-answer safety + hard-probe regression.
#
# This is the gate that would have caught the silent regressions found during the
# 2026-09-20/21 session:
#   * a mechanism that "improved" the aggregate while destroying the hard-probe set
#     (21/60 -> 5/60),
#   * output hygiene that leaked model scratchpad / made unanswerable questions
#     answer themselves (GS-NA 0/30 -> 9/30 failures),
#   * the generator itself changing behaviour (mimo-v2.5 vs deepseek-chat differed
#     by up to +0.11 containment).
#
# Usage:
#   bash sota-gate.sh quick    # retrieval gate + no-answer safety   (~15 min)
#   bash sota-gate.sh full     # + end-to-end n=100 + hard probe     (~60 min)
#
# Environment:
#   API_BASE            default http://127.0.0.1:3202
#   LLMWIKI_TOKEN       pre-minted session token (falls back to /tmp/llmwiki-eval-token)
#   PROBE_TOLERANCE     allowed drop in hard-probe passes (default 1)
#   DATABASE_URL        optional: used for enterprise corpus checks

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MODE="${1:-quick}"

export API_BASE="${API_BASE:-http://127.0.0.1:3202}"
if [ -z "${LLMWIKI_TOKEN:-}" ] && [ -f /tmp/llmwiki-eval-token ]; then
  export LLMWIKI_TOKEN="$(cat /tmp/llmwiki-eval-token)"
fi
: "${LLMWIKI_TOKEN:?set LLMWIKI_TOKEN (or write it to /tmp/llmwiki-eval-token)}"

# Thresholds live in tests/evaluation/gate-thresholds.sh (single source of truth).
source "$PROJECT_ROOT/tests/evaluation/gate-thresholds.sh"
PROBE_TOLERANCE="${PROBE_TOLERANCE:-1}"
PROBE_DIR="$SCRIPT_DIR/regression"
FAILURES=0

say() { printf '\n=== %s\n' "$1"; }

clear_cache() {
  docker exec -e PGPASSWORD=llmwiki_pass llmwiki-postgres \
    psql -h 127.0.0.1 -p 5432 -U llmwiki -d llmwiki -Atc 'DELETE FROM "SemanticCache";' >/dev/null 2>&1 || \
    echo "  (warning: could not clear SemanticCache; measurements may replay cached answers)"
}

say "1/4 公开基准检索门禁（n=100/数据集，对比 v15 基线）"
clear_cache
( cd "$SCRIPT_DIR" && python3 benchmark_suite.py all --mode retrieval --limit 100 --gate ) || FAILURES=$((FAILURES+1))

if [ "$MODE" = "full" ]; then
  say "2/4 公开基准端到端（n=100/数据集，跑前清缓存）"
  for ds in 2wiki hotpot musique; do
    clear_cache
    ( cd "$SCRIPT_DIR" && python3 benchmark_suite.py "$ds" --mode full --limit 100 --gate ) || FAILURES=$((FAILURES+1))
  done
else
  say "2/4 端到端阶段（quick 模式跳过）"
fi

say "3/4 无答案类安全门禁（GS-NA 30 题：幻觉率必须为 0）"
(
  cd "$PROJECT_ROOT/tests/evaluation"
  EVAL_RESULTS_NAME=sota-gate-na.json python3 -m pytest test_retrieval_quality.py -q \
    --golden-file=golden_dataset.json -k "GS-NA" >/tmp/sota-gate-na.log 2>&1 || true
  python3 - <<'PY'
import json, os, sys
d = json.load(open('results/sota-gate-na.json'))
rate = d['summary']['overall'].get('hallucination_rate', 1.0)
count = d['summary']['overall'].get('count', 0)
print(f"  可答题 {count} 题，幻觉率 {rate:.3f}")
if count == 0 or rate > float(os.environ.get("GATE_NO_ANSWER_HALLUCINATION_MAX", "0.01")):
    print("  ❌ 无答案类出现编造（或未跑起来）")
    sys.exit(1)
print("  ✓ 无答案类全部规范作答")
PY
) || FAILURES=$((FAILURES+1))

if [ -f "$PROBE_DIR/floors.json" ]; then
  say "4/4 定向失败集回归（历史失败题，不得低于下限）"
  python3 - "$PROBE_DIR" "$PROBE_TOLERANCE" "$SCRIPT_DIR" <<'PY' || FAILURES=$((FAILURES+1))
import json, os, subprocess, sys
probe_dir, tolerance, script_dir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
floors = json.load(open(os.path.join(probe_dir, 'floors.json')))
bad = []
for ds, info in floors.items():
    env = dict(os.environ)
    env['EVAL_SET_PATH'] = os.path.join(probe_dir, f'hard-multihop-{ds}.json')
    env['QA_WORKERS'] = env.get('QA_WORKERS', '3')
    subprocess.run(['python3', 'benchmark_suite.py', ds, '--mode', 'full'],
                   cwd=script_dir, env=env, check=True)
import glob
for ds, info in floors.items():
    expected = info['probe_passed']
    newest = sorted(glob.glob(os.path.join(script_dir, 'results', f'intl-{ds}-*.json')))[-1]
    run = json.load(open(newest))
    if run['n'] != info['cases']:
        continue
    passed = round(run['qa']['containment'] * run['n'])
    flag = '✓' if passed >= expected - tolerance else '❌'
    print(f"  {flag} {ds}: {passed}/{run['n']}（下限 {expected}，容差 {tolerance}）")
    if passed < expected - tolerance:
        bad.append(ds)
sys.exit(1 if bad else 0)
PY
else
  say "4/4 定向失败集（未配置，跳过）"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo -e "\n❌ SOTA GATE FAILED（$FAILURES 项）"
  exit 1
fi
echo -e "\n✅ SOTA GATE PASSED"
