-- 20260920130000_document_content_hash_expression_index
--
-- Content-hash parsing dedup ("L2 cache") looks documents up by
-- parserMetadata->>'contentHash'. The existing GIN index on parserMetadata
-- (jsonb_path_ops, see 20260918140000_large_scale_optimization) serves the
-- containment predicate `parserMetadata @> '{"contentHash": ...}'` used by the
-- ingestion path, but a plain `->>`/`#>>` comparison cannot use it at all.
--
-- This expression index covers the extraction form as well, so any remaining
-- path-style lookup (and ad-hoc operator queries during an incident) stays
-- index-backed instead of degrading to a sequential scan of "Document".

CREATE INDEX IF NOT EXISTS document_parser_content_hash_expr_idx
  ON "Document" (("parserMetadata" ->> 'contentHash'))
  WHERE "parserMetadata" IS NOT NULL;
