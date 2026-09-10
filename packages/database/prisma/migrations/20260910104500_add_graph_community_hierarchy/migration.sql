-- Hierarchical community detection fingerprint.
ALTER TABLE "GraphCommunity" ADD COLUMN "fingerprint" TEXT;

CREATE INDEX "GraphCommunity_kbId_fingerprint_idx" ON "GraphCommunity"("kbId", "fingerprint");
