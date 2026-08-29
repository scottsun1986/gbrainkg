-- Shared GBrain source plus private permission-group source catalog.
CREATE TABLE IF NOT EXISTS "BrainSource" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sourceKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BrainSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BrainSource_sourceKey_key" ON "BrainSource"("sourceKey");
CREATE INDEX IF NOT EXISTS "BrainSource_kind_status_idx" ON "BrainSource"("kind", "status");

CREATE TABLE IF NOT EXISTS "BrainSourceMember" (
    "sourceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    CONSTRAINT "BrainSourceMember_pkey" PRIMARY KEY ("sourceId", "userId"),
    CONSTRAINT "BrainSourceMember_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BrainSource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BrainSourceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BrainSourceMember_userId_idx" ON "BrainSourceMember"("userId");

CREATE TABLE IF NOT EXISTS "BrainSourceDocument" (
    "sourceId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "syncedVersion" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BrainSourceDocument_pkey" PRIMARY KEY ("sourceId", "documentId"),
    CONSTRAINT "BrainSourceDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BrainSource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BrainSourceDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BrainSourceDocument_documentId_idx" ON "BrainSourceDocument"("documentId");
