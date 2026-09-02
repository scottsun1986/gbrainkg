ALTER TABLE "Document"
  ADD COLUMN IF NOT EXISTS "parserEngine" TEXT,
  ADD COLUMN IF NOT EXISTS "parserClassification" TEXT,
  ADD COLUMN IF NOT EXISTS "parserMetadata" JSONB,
  ADD COLUMN IF NOT EXISTS "qualityStatus" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "qualityScore" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "qualityIssues" JSONB;

CREATE INDEX IF NOT EXISTS "Document_qualityStatus_idx" ON "Document"("qualityStatus");
