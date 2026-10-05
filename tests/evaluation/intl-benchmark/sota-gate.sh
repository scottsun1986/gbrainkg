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
case "$MODE" in quick|full) ;; *) echo "Unknown mode: $MODE" >&2; exit 2 ;; esac

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

# Each invocation owns fresh artifacts. Never mutate shared cache/database state.
mkdir -p "$PROJECT_ROOT/tests/evaluation/results"
RUN_DIR="$(mktemp -d "$PROJECT_ROOT/tests/evaluation/results/sota-gate-XXXXXXXX")"
echo "Run artifacts: $RUN_DIR"
export INTL_RESULTS_DIR="$RUN_DIR/public"
mkdir -p "$INTL_RESULTS_DIR"
echo "Cache state is preserved; these runs do not measure cold-cache latency."

say "1/4 公开基准检索门禁（n=100/数据集，对比 v15 基线）"
( cd "$SCRIPT_DIR" && python3 benchmark_suite.py all --mode retrieval --limit 100 --gate ) || FAILURES=$((FAILURES+1))

if [ "$MODE" = "full" ]; then
  say "2/4 公开基准端到端（n=100/数据集，保留缓存）"
  for ds in 2wiki hotpot musique; do
    ( cd "$SCRIPT_DIR" && python3 benchmark_suite.py "$ds" --mode full --limit 100 --gate ) || FAILURES=$((FAILURES+1))
  done
else
  say "2/4 端到端阶段（quick 模式跳过）"
fi

say "3/4 无答案类安全门禁（GS-NA 完整题集）"
(
  cd "$PROJECT_ROOT/tests/evaluation"
  # pytest and the public harness must use the same explicitly selected API.
  EVAL_API_BASE_URL="${API_BASE%/}/api/v1" EVAL_LIMIT=0 \
    EVAL_RESULTS_NAME="${RUN_DIR##*/}/no-answer.json" \
    python3 -m pytest test_retrieval_quality.py -q \
      --golden-file=golden_dataset.json -k "GS-NA" >"$RUN_DIR/no-answer.log" 2>&1 &&
    python3 "$SCRIPT_DIR/sota_gate_results.py" no-answer \
      "$RUN_DIR/no-answer.json" "$PROJECT_ROOT/tests/evaluation/golden_dataset.json"
) || FAILURES=$((FAILURES+1))

if [ -f "$PROBE_DIR/floors.json" ]; then
  say "4/4 定向失败集回归（历史失败题，不得低于下限）"
  PYTHONPATH="$SCRIPT_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 - "$PROBE_DIR" "$PROBE_TOLERANCE" "$SCRIPT_DIR" "$RUN_DIR" <<'PY' || FAILURES=$((FAILURES+1))
import json, os, subprocess, sys
from pathlib import Path
from sota_gate_results import validate_probe
probe_dir, tolerance, script_dir, run_dir = sys.argv[1:]
floors = json.load(open(os.path.join(probe_dir, 'floors.json')))
tolerance = int(tolerance)
if tolerance < 0:
    raise ValueError('PROBE_TOLERANCE must be nonnegative')
if not floors:
    raise ValueError('empty hard-probe floors')
for ds, info in floors.items():
    env = dict(os.environ)
    env['EVAL_SET_PATH'] = os.path.join(probe_dir, f'hard-multihop-{ds}.json')
    env['QA_WORKERS'] = env.get('QA_WORKERS', '3')
    output = Path(run_dir) / 'probes' / ds
    output.mkdir(parents=True)
    env['INTL_RESULTS_DIR'] = str(output)
    subprocess.run(['python3', 'benchmark_suite.py', ds, '--mode', 'full'],
                   cwd=script_dir, env=env, check=True)
    files = list(output.glob(f'intl-{ds}-*.json'))
    if len(files) != 1:
        raise ValueError(f'{ds}: expected one fresh result, found {len(files)}')
    expected_qids = [case['qid'] for case in json.loads(Path(env['EVAL_SET_PATH']).read_text())]
    passed = validate_probe(json.loads(files[0].read_text()), ds, info, tolerance, expected_qids)
    print(f"  ✓ {ds}: {passed}/{info['cases']}（下限 {info['probe_passed']}，容差 {tolerance}）")
PY
else
  say "4/4 定向失败集（缺少 floors.json，失败）"
  FAILURES=$((FAILURES+1))
fi

if [ "$FAILURES" -gt 0 ]; then
  echo -e "\n❌ SOTA GATE FAILED（$FAILURES 项）"
  exit 1
fi
echo -e "\n✅ SOTA GATE PASSED"
