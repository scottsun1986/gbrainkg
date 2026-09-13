-- Create pg_trgm extension for fuzzy trigram matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN trigram index on content for high-performance fuzzy text matching
CREATE INDEX IF NOT EXISTS chunk_content_trgm_idx ON "Chunk" USING GIN (content gin_trgm_ops);

