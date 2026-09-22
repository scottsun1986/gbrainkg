-- CanonicalBlock v1 + optional BGE-M3 hybrid representations.
-- Dense vectors remain in Chunk.embedding. Learned sparse weights use an
-- inverted table; ColBERT token vectors stay JSONB because they only rerank a
-- small ACL-filtered candidate pool and should not create one HNSW row/token.

ALTER TABLE "Chunk"
  ADD COLUMN IF NOT EXISTS multi_vector jsonb,
  ADD COLUMN IF NOT EXISTS late_context boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hybrid_indexed boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "ChunkSparseEmbedding" (
  "chunkId" uuid NOT NULL REFERENCES "Chunk"(id) ON DELETE CASCADE,
  "tokenId" integer NOT NULL,
  weight real NOT NULL,
  PRIMARY KEY ("chunkId", "tokenId")
);

CREATE INDEX IF NOT EXISTS chunk_sparse_token_weight_idx
  ON "ChunkSparseEmbedding" ("tokenId", weight DESC);

CREATE INDEX IF NOT EXISTS chunk_sparse_chunk_idx
  ON "ChunkSparseEmbedding" ("chunkId");

-- Existing chunks receive the same stable contract as newly ingested chunks.
-- Content hashes use PostgreSQL md5 for the migration-only compatibility
-- record; newly ingested blocks use SHA-256 and identify that in their values.
UPDATE "Chunk" c
SET metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
  'canonical_block',
  jsonb_build_object(
    'schema', 'canonical-block/v1',
    'id', c."documentId"::text || ':v' || d.version::text || ':' || c.ord::text,
    'document', jsonb_build_object(
      'id', d.id, 'kbId', d."kbId", 'title', d.title,
      'version', d.version, 'sourceType', d."sourceType"
    ),
    'position', jsonb_strip_nulls(jsonb_build_object(
      'ord', c.ord, 'charStart', c."charStart", 'charEnd', c."charEnd",
      'page', c.metadata->'page_no', 'section', c.metadata->'section',
      'breadcrumb', c.metadata->'breadcrumb', 'article', c.metadata->'article_no'
    )),
    'structure', jsonb_build_object(
      'kind', CASE WHEN COALESCE(c.metadata->>'has_table', 'false') IN ('true', '1') THEN 'mixed' ELSE 'text' END,
      'headingHierarchy', COALESCE(c.metadata->'heading_hierarchy', '[]'::jsonb),
      'tableHeaders', COALESCE(c.metadata->'table_headers', '[]'::jsonb),
      'bboxes', COALESCE(c.metadata->'bboxes', '[]'::jsonb),
      'previousOrd', c.metadata->'prev_chunk_ord',
      'nextOrd', c.metadata->'next_chunk_ord'
    ),
    'content', jsonb_build_object(
      'md5', md5(c.content), 'indexableMd5', md5(c.content), 'tokenCount', c."tokenCount"
    ),
    'retrieval', jsonb_build_object(
      'dense', c.embedding IS NOT NULL,
      'sparse', false,
      'multiVector', false,
      'contextualized', c.metadata ? 'contextual_prefix'
    )
  )
)
FROM "Document" d
WHERE d.id = c."documentId"
  AND NOT (COALESCE(c.metadata, '{}'::jsonb) ? 'canonical_block');
