#!/bin/bash
# Scale benchmark: seeds an isolated schema with a large synthetic corpus using
# the real indexing code and then measures retrieval quality, latency and size.
#
#   bash scripts/run-scale-benchmark.sh                 # 100k chunks
#   CHUNKS=400000 bash scripts/run-scale-benchmark.sh   # ~100k documents
#
# The benchmark owns one dedicated PostgreSQL schema. It never touches the
# application schema ("public"), never runs against the production host, and
# drops only the schema it created.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

SCHEMA="${SCHEMA:-scale_bench}"
CHUNKS="${CHUNKS:-100000}"
KB_COUNT="${KB_COUNT:-40}"
QUERIES="${QUERIES:-100}"
OUT_DIR="${OUT_DIR:-tests/evaluation/intl-benchmark/reports}"

if [ "$SCHEMA" = "public" ]; then
  echo "Refusing to run: SCHEMA must not be the application schema." >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
SEED_OUT="$OUT_DIR/scale-${CHUNKS}-${SCHEMA}-seed.json"
EVAL_OUT="$OUT_DIR/scale-${CHUNKS}-${SCHEMA}-retrieval.json"

echo "========================================"
echo "  Scale benchmark: schema=$SCHEMA chunks=$CHUNKS"
echo "========================================"

pnpm --filter api scale:seed -- \
  --schema="$SCHEMA" --chunks="$CHUNKS" --kb-count="$KB_COUNT" --out="$SEED_OUT"

echo ""
echo "--- filtered ANN recall (exact KNN as gold) ---"
ANN_EVAL_DATABASE_URL="${ANN_EVAL_DATABASE_URL:-$(node scripts/bench-database-url.cjs "$SCHEMA")}"
python3 tests/evaluation/intl-benchmark/ann_recall_eval.py \
  --database-url "$ANN_EVAL_DATABASE_URL" \
  --limit "$QUERIES" --k 10 \
  --ef-search 40 100 200 \
  --iterative-scan off relaxed_order \
  --out "$EVAL_OUT"

echo ""
echo "--- full-corpus BM25 latency on the same corpus ---"
pnpm --filter api lexical:probe -- "企业制度报销标准" --repeat=5 \
  --database-url "$ANN_EVAL_DATABASE_URL" || true

echo ""
echo "Reports written:"
echo "  $SEED_OUT"
echo "  $EVAL_OUT"
