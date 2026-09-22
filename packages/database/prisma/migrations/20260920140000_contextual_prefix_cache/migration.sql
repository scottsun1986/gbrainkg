-- 20260920140000_contextual_prefix_cache
--
-- Durable memo for Contextual Retrieval prefixes.
--
-- The prefix for a chunk is a pure function of (model, prompt version, chunk
-- text, neighbouring window), so it can be reused across processes, restarts
-- and instances. Without persistence every retry / re-ingest / duplicate upload
-- re-paid one LLM call per chunk.
--
-- The key is the SHA-256 of the exact request payload, so a prompt or window
-- change cannot replay a stale prefix; old rows simply stop being hit and are
-- pruned by the probabilistic retention sweep on the write path.

CREATE TABLE IF NOT EXISTS "ContextualPrefixCache" (
  "key"        text PRIMARY KEY,
  "value"      text NOT NULL,
  "createdAt"  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hitCount"   integer NOT NULL DEFAULT 0
);

-- Retention sweep scans by last use.
CREATE INDEX IF NOT EXISTS contextual_prefix_cache_last_used_idx
  ON "ContextualPrefixCache" ("lastUsedAt");
