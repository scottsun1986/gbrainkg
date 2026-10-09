-- F05 graph entity identity.
--
-- 1. GraphEntity gains an explicit entityKey = normalized(name)|type and the
--    uniqueness moves from (kbId, name) to (kbId, entityKey). name stays a
--    reusable label: a system and an organisation with the same spelling can
--    now coexist instead of silently overwriting each other's type.
--    Backfill uses the same normalization the application writer applies
--    (trim, lowercase, collapse internal whitespace).
-- 2. GraphEntityAlias is a reviewable merge ledger: every surface-form merge
--    keeps its evidence and is removed with its canonical entity.

ALTER TABLE "GraphEntity" ADD COLUMN "entityKey" text;
UPDATE "GraphEntity"
   SET "entityKey" = regexp_replace(lower(btrim("name")), '\s+', ' ', 'g') || '|' || "type";
ALTER TABLE "GraphEntity" ALTER COLUMN "entityKey" SET NOT NULL;
DROP INDEX "GraphEntity_kbId_name_key";
CREATE UNIQUE INDEX "GraphEntity_kbId_entityKey_key" ON "GraphEntity"("kbId", "entityKey");

CREATE TABLE "GraphEntityAlias" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "kbId" uuid NOT NULL,
  "entityId" uuid NOT NULL,
  "alias" text NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GraphEntityAlias_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GraphEntityAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "GraphEntity"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "GraphEntityAlias_kbId_alias_key" ON "GraphEntityAlias"("kbId", "alias");
CREATE INDEX "GraphEntityAlias_entityId_idx" ON "GraphEntityAlias"("entityId");
