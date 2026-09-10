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

# SOTA thresholds (can be overridden by environment)
export GATE_HIT_RATE="${GATE_HIT_RATE:-0.90}"
export GATE_KEYWORD_COVERAGE="${GATE_KEYWORD_COVERAGE:-0.85}"
export GATE_PERMISSION_RATE="${GATE_PERMISSION_RATE:-1.00}"
export GATE_NO_HALLUCINATION="${GATE_NO_HALLUCINATION:-0.95}"
export GATE_FAITHFULNESS="${GATE_FAITHFULNESS:-0.95}"
export GATE_CITATION_ACCURACY="${GATE_CITATION_ACCURACY:-0.90}"
export GATE_CONTEXT_PRECISION="${GATE_CONTEXT_PRECISION:-0.85}"

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

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ QUALITY GATE PASSED"
else
  echo ""
  echo "❌ QUALITY GATE FAILED"
  echo "Please review the evaluation report above."
fi

exit $EXIT_CODE
