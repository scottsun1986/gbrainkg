-- Semantic Cache: stores query embeddings and cached responses
-- for similar-question deduplication across users with matching permission scopes
CREATE TABLE IF NOT EXISTS "SemanticCache" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "queryText" TEXT NOT NULL,
    "queryEmbedding" vector(1024),
    "scopeFingerprint" TEXT NOT NULL,
    "knowledgeEpoch" INTEGER NOT NULL DEFAULT 0,
    "responseContent" TEXT NOT NULL,
    "citations" JSONB,
    "processingTrace" JSONB,
    "modelName" TEXT,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHitAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "SemanticCache_pkey" PRIMARY KEY ("id")
);

-- HNSW index for fast semantic similarity search
CREATE INDEX IF NOT EXISTS "SemanticCache_embedding_idx" 
    ON "SemanticCache" USING hnsw ("queryEmbedding" vector_cosine_ops);

-- Composite index for scope + epoch filtering during cache lookup
CREATE INDEX IF NOT EXISTS "SemanticCache_scope_epoch_idx" 
    ON "SemanticCache" ("scopeFingerprint", "knowledgeEpoch");

-- TTL cleanup index
CREATE INDEX IF NOT EXISTS "SemanticCache_expires_idx" 
    ON "SemanticCache" ("expiresAt") WHERE "expiresAt" IS NOT NULL;
