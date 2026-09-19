-- 20260919090000_chunk_content_hash_index
-- Content-hash dedup lookups in ChunkEmbeddingService compare md5(content)
-- against an array of precomputed hashes. The existing gin_trgm index on
-- "Chunk".content does not serve equality predicates, so add an expression
-- btree index that exactly matches the query expression md5(content).

CREATE INDEX IF NOT EXISTS chunk_content_md5_idx ON "Chunk" (md5(content));
