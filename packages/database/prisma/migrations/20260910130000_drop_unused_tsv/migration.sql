-- The Chunk.tsv column, its GIN index and trigger used the 'simple'
-- text-search configuration, which does not tokenize Chinese. The index
-- provided no retrieval benefit while adding write amplification on every
-- chunk insert/update, so it is removed. Chunk retrieval is handled by the
-- pgvector HNSW index and application-level keyword search.
DROP TRIGGER IF EXISTS chunks_tsv_update ON "Chunk";
-- A manually-applied search-optimization script (deploy/migrations) created
-- the same tsv-maintenance trigger under different names. Its function reads
-- the tsv column via NEW, so after the column drop every Chunk INSERT failed
-- with Prisma P2022 "The column `new` does not exist". Drop those too.
DROP TRIGGER IF EXISTS trigger_update_chunk_tsv ON "Chunk";
DROP FUNCTION IF EXISTS chunks_tsv_trigger();
DROP FUNCTION IF EXISTS update_chunk_tsv();
DROP INDEX IF EXISTS chunks_tsv_gin_idx;
ALTER TABLE "Chunk" DROP COLUMN IF EXISTS tsv;
