#!/bin/bash
# RAG Quality Gate - CI/CD Integration Script
# 
# Usage: ./tests/evaluation/ci-gate.sh
# Returns exit code 0 on PASS, 1 on FAIL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "========================================"
echo "  RAG Quality Gate - CI/CD"
echo "========================================"
echo ""

# SOTA thresholds — single source of truth shared with the GitHub workflows.
# Release mode note: when GATE_STRICT=1 every live gate must actually run; a
# missing credential, unreachable service or absent dataset is a FAILURE rather
# than a skip. The default (0) keeps local/offline development usable.
source "$SCRIPT_DIR/gate-thresholds.sh"

echo "Thresholds:"
echo "  Hit Rate:          >= $GATE_HIT_RATE"
echo "  Keyword Coverage:  >= $GATE_KEYWORD_COVERAGE"
echo "  Permission Rate:   >= $GATE_PERMISSION_RATE"
echo "  No Hallucination:  >= $GATE_NO_HALLUCINATION"
echo "  Faithfulness:      >= $GATE_FAITHFULNESS"
echo "  Citation Accuracy: >= $GATE_CITATION_ACCURACY"
echo "  Context Precision: >= $GATE_CONTEXT_PRECISION"
echo ""

# Run the quality gate
cd "$PROJECT_ROOT"
npx --yes tsx@4.23.13 tests/evaluation/quality-gate.ts
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "❌ QUALITY GATE FAILED"
  echo "Please review the evaluation report above."
  exit 1
fi

echo ""
echo "✅ OFFLINE QUALITY GATE PASSED"

# ---------------------------------------------------------------------------
# Live gates. Each one is skipped only when GATE_STRICT=0; a release run
# (GATE_STRICT=1) treats "cannot run" as a failure so a missing credential can
# never be mistaken for a passing benchmark.
# ---------------------------------------------------------------------------
STRICT_FAILURES=0

gate_step() {
  local name="$1"; shift
  echo ""
  echo "========================================"
  echo "  Live gate: $name"
  echo "========================================"
  if "$@"; then
    echo "✅ $name passed"
    return 0
  fi
  echo "❌ $name failed or could not run"
  if [ "$GATE_STRICT" = "1" ]; then
    STRICT_FAILURES=$((STRICT_FAILURES + 1))
  fi
  return 1
}

should_run_live() {
  if [ "${CHECK_INTL:-0}" = "1" ] || [ "$GATE_STRICT" = "1" ]; then
    return 0
  fi
  echo "ℹ️  Skipping live gates (set CHECK_INTL=1 or GATE_STRICT=1 to enable)."
  return 1
}

if should_run_live; then
  # 1. Public multi-hop benchmarks against the live API.
  gate_step "international retrieval benchmark" \
    python3 tests/evaluation/intl-benchmark/benchmark_suite.py all --mode retrieval --gate

  # 2. Filtered ANN recall against exact KNN (pgvector). Reading a database is
  #    enough; no API needed.
  if [ -n "${ANN_EVAL_DATABASE_URL:-${DATABASE_URL:-}}" ]; then
    gate_step "filtered HNSW Recall@10" \
      python3 tests/evaluation/intl-benchmark/ann_recall_eval.py \
        --limit "${ANN_EVAL_QUERIES:-50}" --k 10 \
        --ef-search "${VECTOR_EF_SEARCH:-100}" --iterative-scan "${VECTOR_ITERATIVE_SCAN:-relaxed_order}" \
        --target-recall "$GATE_ANN_RECALL"
  else
    echo "❌ filtered HNSW recall gate cannot run: ANN_EVAL_DATABASE_URL/DATABASE_URL is not set"
    [ "$GATE_STRICT" = "1" ] && STRICT_FAILURES=$((STRICT_FAILURES + 1))
  fi
fi

if [ "$GATE_STRICT" = "1" ] && [ "$STRICT_FAILURES" -gt 0 ]; then
  echo ""
  echo "❌ $STRICT_FAILURES live gate(s) failed in strict release mode."
  exit 1
fi

if [ "$STRICT_FAILURES" -eq 0 ]; then
  echo ""
  echo "🎯 All enabled gates passed."
else
  echo ""
  echo "⚠️  Live gates were skipped (development mode). Release requires GATE_STRICT=1."
fi
exit 0
