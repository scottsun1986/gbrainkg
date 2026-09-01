-- Derived pages are only usable while their exact ACL and knowledge snapshot
-- remains valid. Defaults deliberately invalidate pre-upgrade derived pages.
ALTER TABLE "BrainDerivedPage"
  ADD COLUMN "sourceKeys" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "aclEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "knowledgeEpoch" INTEGER NOT NULL DEFAULT 0;
