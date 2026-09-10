-- Self-referencing community hierarchy.
ALTER TABLE "GraphCommunity" ADD COLUMN "parentCommunityId" UUID;

CREATE INDEX "GraphCommunity_parentCommunityId_idx" ON "GraphCommunity"("parentCommunityId");

ALTER TABLE "GraphCommunity" ADD CONSTRAINT "GraphCommunity_parentCommunityId_fkey"
    FOREIGN KEY ("parentCommunityId") REFERENCES "GraphCommunity"("id") ON UPDATE CASCADE ON DELETE SET NULL;
