#!/usr/bin/env bash
# GBrainKG unified CI pipeline.
#
# Runs every automated quality layer in order and fails fast. Layers that need
# a live API + seeded corpus require LLMWIKI_TOKEN (or LLMWIKI_USER/PASS) and
# are skipped with a warning when it is absent, so the unit layers still run.
#
# Usage:
#   LLMWIKI_TOKEN=<jwt> bash scripts/ci.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
run() {
  local name="$1"; shift
  echo ""
  echo "=================================================="
  echo "  $name"
  echo "=================================================="
  if "$@"; then
    echo "[CI] $name: PASS"
  else
    echo "[CI] $name: FAIL"
    FAILED=1
  fi
}

run "Prisma client generate" pnpm --filter database exec prisma generate --schema=prisma/schema.prisma
run "API unit tests" pnpm run test:api
run "Parser worker tests" pnpm run test:parser
run "GBrain adapter contract tests" pnpm run test:adapter
# Evaluation harness self-tests need no network/API: they validate the metric
# math, BEIR subsetting (gold docs never dropped) and latency percentiles, so
# a broken gateway is caught before any live benchmark run.
run "Evaluation harness self-tests" pnpm run benchmark:selftest

# Official-qrels IR regression gate. Enabled by producing a run file with
# beir_pipeline.py and exporting BEIR_QRELS + BEIR_RUN. IR_GATE_THRESHOLDS uses
# comma-separated metric=value pairs (metric names are the same as the CLI --k
# output, e.g. ndcg@10, recall@100, mrr@10, map@10).
if [[ -n "${BEIR_QRELS:-}" && -n "${BEIR_RUN:-}" ]]; then
  run "Official-qrels IR gate" python3 tests/evaluation/intl-benchmark/standard_ir_eval.py \
    --qrels "$BEIR_QRELS" --run "$BEIR_RUN" \
    --threshold "${IR_GATE_THRESHOLDS:-ndcg@10=0.5,recall@100=0.8}"
else
  echo ""
  echo "[CI] Skipping official-qrels IR gate: set BEIR_QRELS and BEIR_RUN (see tests/evaluation/intl-benchmark/README.md §6)."
fi

if [[ -n "${LLMWIKI_TOKEN:-}${LLMWIKI_USER:-}" ]]; then
  run "E2E knowledge-base scenario suite" python3 tests/e2e/sota_knowledge_base_suite.py
  run "SOTA retrieval quality gate" bash tests/evaluation/ci-gate.sh
else
  echo ""
  echo "[CI] Skipping E2E suite + quality gate: set LLMWIKI_TOKEN (or LLMWIKI_USER/LLMWIKI_PASS)."
fi

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo "[CI] ALL LAYERS PASSED"
else
  echo "[CI] PIPELINE FAILED"
fi
exit "$FAILED"
