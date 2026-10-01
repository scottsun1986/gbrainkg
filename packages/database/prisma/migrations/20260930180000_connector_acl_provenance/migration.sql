ALTER TABLE "Document" ADD COLUMN "sourceExternalRevision" text, ADD COLUMN "sourceExternalAcl" jsonb,
  ADD COLUMN "sourceAclSyncStatus" text NOT NULL DEFAULT 'unknown', ADD COLUMN "sourceAclSyncedAt" timestamp(3);
