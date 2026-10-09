-- Expand only: existing versions, raw files and Markdown remain intact.
CREATE TABLE "ImportBatch" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "kbId" uuid NOT NULL,
  "uploadedById" uuid NOT NULL,
  "archiveName" text NOT NULL,
  "items" jsonb NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportBatch_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE
);
CREATE INDEX "ImportBatch_kbId_createdAt_idx" ON "ImportBatch"("kbId", "createdAt");
