-- 20260918140000_large_scale_optimization
-- Large-scale database indexing and query acceleration for massive knowledge base documents

-- 1. Ensure trigram extension for accelerated lexical search and Chinese substring indexing
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Covering composite index on Chunk for fast document chunk retrieval and ordering
CREATE INDEX IF NOT EXISTS chunk_kbid_docid_ord_idx 
  ON "Chunk" ("kbId", "documentId", ord);

-- 3. GIN Trigram index on Chunk content for fast substring / ILIKE acceleration
CREATE INDEX IF NOT EXISTS chunk_content_trgm_idx 
  ON "Chunk" USING gin (content gin_trgm_ops);

-- 4. Composite index on Document for inventory and status listing queries
CREATE INDEX IF NOT EXISTS document_kbid_status_updated_idx 
  ON "Document" ("kbId", status, "updatedAt" DESC);

-- 5. GIN index on Document parserMetadata for instant contentHash deduplication lookups
CREATE INDEX IF NOT EXISTS document_parser_metadata_gin_idx 
  ON "Document" USING gin ("parserMetadata" jsonb_path_ops);

-- 6. Composite index on KnowledgeBase for status and name queries
CREATE INDEX IF NOT EXISTS kb_status_name_idx 
  ON "KnowledgeBase" (status, name);
