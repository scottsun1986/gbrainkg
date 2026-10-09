-- F01 connector sync recovery: execution lease columns on ConnectorRun.
-- Additive and nullable: pre-existing running rows (ownerId NULL, no lease)
-- are treated as expired by the claim path and reclaimed by the next sync.
ALTER TABLE "ConnectorRun"
  ADD COLUMN "ownerId" text,
  ADD COLUMN "leaseExpiresAt" timestamp(3),
  ADD COLUMN "heartbeatAt" timestamp(3);

-- Claim path looks up the single running row per source; recovery scans by
-- status + expiry.
CREATE INDEX "ConnectorRun_status_leaseExpiresAt_idx"
  ON "ConnectorRun"("status", "leaseExpiresAt");
