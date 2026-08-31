-- Legacy compatibility script. New deployments apply the equivalent
-- idempotent migration through Prisma migrate deploy automatically:
-- 20260831090100_add_search_indexes/migration.sql
-- Keep this file only for operators upgrading an older installation that
-- cannot yet use the Prisma migration runner.

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add vector column for embeddings
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Add tsvector column for full-text search
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS tsv tsvector;

-- Create HNSW index for vector similarity search
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx 
  ON "Chunk" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Create GIN index for full-text search
CREATE INDEX IF NOT EXISTS chunks_tsv_gin_idx 
  ON "Chunk" USING gin (tsv);

-- Create trigger to auto-update tsvector on content change
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

-- Backfill tsvector for existing rows
UPDATE "Chunk" SET tsv = to_tsvector('simple', COALESCE(content, '')) WHERE tsv IS NULL;
