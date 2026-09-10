-- Scope-exact cache fingerprint for semantic cache invalidation.
ALTER TABLE "SemanticCache" ADD COLUMN "cacheFingerprint" TEXT;

CREATE INDEX "SemanticCache_scope_epoch_fingerprint_idx"
    ON "SemanticCache"("scopeFingerprint", "knowledgeEpoch", "cacheFingerprint");
