-- The Chunk.tsv column, its GIN index and trigger used the 'simple'
-- text-search configuration, which does not tokenize Chinese. The index
-- provided no retrieval benefit while adding write amplification on every
-- chunk insert/update, so it is removed. Chunk retrieval is handled by the
-- pgvector HNSW index and application-level keyword search.
DROP TRIGGER IF EXISTS chunks_tsv_update ON "Chunk";
DROP FUNCTION IF EXISTS chunks_tsv_trigger();
DROP INDEX IF EXISTS chunks_tsv_gin_idx;
ALTER TABLE "Chunk" DROP COLUMN IF EXISTS tsv;
