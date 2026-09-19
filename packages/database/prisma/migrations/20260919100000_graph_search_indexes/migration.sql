-- GraphRAG substring lookup and document-provenance cleanup indexes.
-- pg_trgm is already part of the large-scale search migration; retain the
-- guard so this migration remains safe for independently provisioned DBs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS graph_entity_name_trgm_idx
  ON "GraphEntity" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS graph_entity_properties_gin_idx
  ON "GraphEntity" USING gin ("properties" jsonb_path_ops);

CREATE INDEX IF NOT EXISTS graph_relation_provenance_gin_idx
  ON "GraphRelation" USING gin ("provenance" jsonb_path_ops);
