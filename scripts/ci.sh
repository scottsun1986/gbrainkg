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
