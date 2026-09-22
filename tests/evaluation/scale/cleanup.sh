#!/bin/bash
# Cleanup for the 100k scale benchmark artefacts (dev/test only).
#
#   bash tests/evaluation/scale/cleanup.sh            # drop scale_* schemas + SCALE100K- rows
#   KEEP_PUBLIC=1 bash tests/evaluation/scale/cleanup.sh  # only drop isolated schemas
#
# Never touches production. Refuses to run without a local DATABASE_URL or
# docker postgres container named llmwiki-postgres.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_ROOT"

PSQL=(docker exec -i llmwiki-postgres psql -U llmwiki -d llmwiki -v ON_ERROR_STOP=1)

echo "== drop isolated benchmark schemas =="
for schema in scale_10k scale_50k scale_bench scale_bench_10k scale_bench_50k; do
  "${PSQL[@]}" <<SQL
DROP SCHEMA IF EXISTS "${schema}" CASCADE;
SQL
  echo "dropped schema ${schema} (if it existed)"
done

if [ "${KEEP_PUBLIC:-0}" = "1" ]; then
  echo "KEEP_PUBLIC=1 — leaving public SCALE100K- corpus in place"
  exit 0
fi

echo "== delete SCALE100K- / scale-bench-100k rows from public =="
"${PSQL[@]}" <<'SQL'
-- Prefer the dedicated KB first (documents cascade to chunks + lexical).
DELETE FROM "KnowledgeBase" WHERE name IN ('scale-bench-100k', 'SCALE100K-scale-bench-100k');
-- Belt-and-braces: any leftover synthetic docs still carrying the prefix.
DELETE FROM "Document" WHERE title LIKE 'SCALE100K-%' OR mdPath LIKE '/synthetic/%';
SQL

echo "cleanup complete"
