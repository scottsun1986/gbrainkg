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

# Default thresholds (can be overridden by environment)
export GATE_HIT_RATE="${GATE_HIT_RATE:-0.80}"
export GATE_KEYWORD_COVERAGE="${GATE_KEYWORD_COVERAGE:-0.75}"
export GATE_PERMISSION_RATE="${GATE_PERMISSION_RATE:-1.00}"
export GATE_NO_HALLUCINATION="${GATE_NO_HALLUCINATION:-0.90}"

echo "Thresholds:"
echo "  Hit Rate:          >= $GATE_HIT_RATE"
echo "  Keyword Coverage:  >= $GATE_KEYWORD_COVERAGE"
echo "  Permission Rate:   >= $GATE_PERMISSION_RATE"
echo "  No Hallucination:  >= $GATE_NO_HALLUCINATION"
echo ""

# Run the quality gate
cd "$PROJECT_ROOT"
npx tsx tests/evaluation/quality-gate.ts
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
