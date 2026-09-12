-- Vector embeddings for RAPTOR summary nodes and GraphRAG community
-- summaries. Retrieval over these nodes was previously keyword-contains only;
-- the embedding column enables cosine recall for macro/global questions.
-- Columns are nullable: rows written before this migration (or when the
-- embedding provider is disabled) simply keep falling back to keyword search.

ALTER TABLE "RaptorNode" ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE "GraphCommunity" ADD COLUMN IF NOT EXISTS embedding vector(1024);

CREATE INDEX IF NOT EXISTS raptor_nodes_embedding_hnsw_idx
  ON "RaptorNode" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS graph_communities_embedding_hnsw_idx
  ON "GraphCommunity" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
