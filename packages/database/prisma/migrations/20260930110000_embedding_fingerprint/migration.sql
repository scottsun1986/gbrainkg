-- Unknown historic vectors are intentionally not stamped with the current model.
ALTER TABLE "Chunk" ADD COLUMN embedding_fingerprint text;
CREATE INDEX chunk_embedding_reuse_idx ON "Chunk" (embedding_fingerprint, md5(content))
WHERE embedding IS NOT NULL;
