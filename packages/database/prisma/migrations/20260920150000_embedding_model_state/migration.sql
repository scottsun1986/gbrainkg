-- 20260920150000_embedding_model_state
--
-- Which embedding space are the stored chunk vectors in?
--
-- The provider-side cache key already includes the route/model/dimensions, but
-- the database did not: after an embedding-model migration the new query vector
-- was compared against vectors written by the old model, which produces
-- plausible-looking but meaningless cosine similarities (there is no error, just
-- garbage recall). Recording the model per knowledge base makes that condition
-- detectable instead of silent.
--
-- One row per KB, written by the embedding worker after a document is embedded.

CREATE TABLE IF NOT EXISTS "EmbeddingModelState" (
  "kbId"       uuid PRIMARY KEY,
  "modelName"  text NOT NULL,
  "dimension"  integer,
  "updatedAt"  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "chunksAtWrite" integer
);
