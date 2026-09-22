#!/usr/bin/env bash
# GBrainKG unified CI pipeline.
#
# Runs every automated quality layer in order and fails fast. Layers that need
# a live API + seeded corpus require LLMWIKI_TOKEN (or LLMWIKI_USER/PASS) and
# are skipped with a warning when it is absent, so the unit layers still run.
#
# Usage:
#   LLMWIKI_TOKEN=<jwt> bash scripts/ci.sh
#   GATE_STRICT=1 bash scripts/ci.sh     # release-gate mode (used by deploy-prod.sh)
#
# GATE_STRICT=1 contract:
#   - any failing layer  -> process exits non-zero (deploy must abort)
#   - missing e2e token  -> layers are still skipped (as above) but a prominent
#                           WARN is printed so a "green" gate cannot silently
#                           claim full e2e coverage
# This script never runs a dist-writing build; callers that need artifacts
# build them themselves (deploy-prod.sh already does).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GATE_STRICT="${GATE_STRICT:-0}"
FAILED=0
E2E_SKIPPED=0
IR_SKIPPED=0

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

warn_skip() {
  # warn_skip <layer-name> <how-to-enable>
  local layer="$1"; shift
  if [[ "$GATE_STRICT" == "1" ]]; then
    echo ""
    echo "[CI] WARN: GATE_STRICT=1 but '$layer' was SKIPPED."
    echo "[CI] WARN:   enable: $*"
    echo "[CI] WARN:   Release gate is incomplete without this layer."
  fi
}

run "Prisma client generate" pnpm --filter database exec prisma generate --schema=prisma/schema.prisma
run "API unit tests" pnpm run test:api
run "Parser worker tests" pnpm run test:parser
run "GBrain adapter contract tests" pnpm run test:adapter
# P2: web unit tests (node:test via tsx, pure helpers only) + parser-worker
# lint/type baseline. Ruff/mypy are skipped with a notice when not installed
# so the unit layers still run on bare checkouts.
run "Web unit tests" pnpm --filter web test
if python3 -c "import ruff" >/dev/null 2>&1 || command -v ruff >/dev/null 2>&1; then
  run "Parser worker ruff" bash -c 'cd apps/parser-worker && (command -v ruff >/dev/null && ruff check src tests || python3 -m ruff check src tests)'
else
  echo ""
  echo "[CI] Skipping parser-worker ruff: not installed (pip install -r apps/parser-worker/requirements.lock.txt)."
fi
if python3 -c "import mypy" >/dev/null 2>&1 || command -v mypy >/dev/null 2>&1; then
  run "Parser worker mypy" bash -c 'cd apps/parser-worker/src && if command -v mypy >/dev/null 2>&1; then mypy --explicit-package-bases --namespace-packages main.py quality.py extractors; else python3 -m mypy --explicit-package-bases --namespace-packages main.py quality.py extractors; fi'
else
  echo ""
  echo "[CI] Skipping parser-worker mypy: not installed (pip install -r apps/parser-worker/requirements.lock.txt)."
fi
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
  IR_SKIPPED=1
  warn_skip "official-qrels IR gate" "export BEIR_QRELS + BEIR_RUN (see tests/evaluation/intl-benchmark/README.md §6)"
fi

if [[ -n "${LLMWIKI_TOKEN:-}${LLMWIKI_USER:-}" ]]; then
  run "E2E knowledge-base scenario suite" python3 tests/e2e/sota_knowledge_base_suite.py
  run "SOTA retrieval quality gate" bash tests/evaluation/ci-gate.sh
else
  echo ""
  echo "[CI] Skipping E2E suite + quality gate: set LLMWIKI_TOKEN (or LLMWIKI_USER/LLMWIKI_PASS)."
  E2E_SKIPPED=1
  warn_skip "E2E suite + SOTA quality gate" "export LLMWIKI_TOKEN (or LLMWIKI_USER/LLMWIKI_PASS)"
fi

# P2 feedback regression gate (optional). Only invoked when LLMWIKI_TOKEN is present;
# scripts/feedback-gate.sh itself no-ops without credentials. GATE_STRICT=1 is
# inherited by the gate so a regression exits non-zero on release pipelines.
if [[ -n "${LLMWIKI_TOKEN:-}" ]]; then
  run "Feedback regression gate" bash scripts/feedback-gate.sh
else
  echo ""
  echo "[CI] Skipping feedback regression gate: LLMWIKI_TOKEN not set."
fi

echo ""
if [[ "$GATE_STRICT" == "1" ]]; then
  echo "[CI] GATE_STRICT=1 summary: FAILED=$FAILED E2E_SKIPPED=$E2E_SKIPPED IR_SKIPPED=$IR_SKIPPED"
fi

if [[ "$FAILED" -eq 0 ]]; then
  echo "[CI] ALL LAYERS PASSED"
  exit 0
else
  echo "[CI] PIPELINE FAILED"
  if [[ "$GATE_STRICT" == "1" ]]; then
    echo "[CI] GATE_STRICT=1: propagating non-zero exit (release must abort)."
  fi
  exit 1
fi
