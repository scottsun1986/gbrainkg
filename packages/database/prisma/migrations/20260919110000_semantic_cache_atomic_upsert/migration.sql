-- Make replacement of an exact semantic-cache entry atomic. The previous
-- DELETE + INSERT pair exposed a miss window and raced under concurrent asks.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "scopeFingerprint", "queryText"
           ORDER BY "createdAt" DESC, "id" DESC
         ) AS row_number
  FROM "SemanticCache"
)
DELETE FROM "SemanticCache" AS cache
USING ranked
WHERE cache."id" = ranked."id"
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS semantic_cache_scope_query_key
  ON "SemanticCache" ("scopeFingerprint", "queryText");
