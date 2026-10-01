ALTER TABLE "Chunk" ADD COLUMN hybrid_fingerprint text;
CREATE INDEX chunk_hybrid_fingerprint ON "Chunk"(hybrid_fingerprint) WHERE hybrid_indexed;
