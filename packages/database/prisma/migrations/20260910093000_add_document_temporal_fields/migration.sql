-- Temporal effectiveness fields for regulation precedence arbitration.
ALTER TABLE "Document" ADD COLUMN "effectiveFrom" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN "effectiveTo" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN "lifecycleStatus" TEXT NOT NULL DEFAULT 'current';
ALTER TABLE "Document" ADD COLUMN "supersedesDocumentId" UUID;

CREATE INDEX "Document_kb_lifecycle_effective_idx"
    ON "Document"("kbId", "lifecycleStatus", "effectiveFrom");
