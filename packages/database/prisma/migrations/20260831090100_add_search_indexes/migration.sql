-- Production migration for semantic and full-text chunk search.
-- Keep this migration idempotent so installations upgraded from the former
-- manually-applied SQL file can converge safely.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS tsv tsvector;

CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON "Chunk" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS chunks_tsv_gin_idx
  ON "Chunk" USING gin (tsv);

CREATE OR REPLACE FUNCTION chunks_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('simple', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_tsv_update ON "Chunk";
CREATE TRIGGER chunks_tsv_update
  BEFORE INSERT OR UPDATE OF content ON "Chunk"
  FOR EACH ROW EXECUTE FUNCTION chunks_tsv_trigger();

UPDATE "Chunk"
SET tsv = to_tsvector('simple', COALESCE(content, ''))
WHERE tsv IS NULL;
