-- Application-owned discovery projection, not authoritative answer evidence.
CREATE TABLE "GraphEntity" (
    "id" UUID NOT NULL,
    "kbId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'concept',
    "description" TEXT,
    "aliases" JSONB NOT NULL DEFAULT '[]',
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GraphEntity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GraphRelation" (
    "id" UUID NOT NULL,
    "kbId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "relationType" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "description" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GraphRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GraphCommunity" (
    "id" UUID NOT NULL,
    "kbId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL,
    "entityIds" JSONB NOT NULL DEFAULT '[]',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GraphCommunity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GraphEntity_kbId_name_key" ON "GraphEntity"("kbId", "name");
CREATE INDEX "GraphEntity_kbId_type_idx" ON "GraphEntity"("kbId", "type");
CREATE INDEX "GraphEntity_name_idx" ON "GraphEntity"("name");
CREATE UNIQUE INDEX "GraphRelation_sourceId_targetId_relationType_key" ON "GraphRelation"("sourceId", "targetId", "relationType");
CREATE INDEX "GraphRelation_kbId_relationType_idx" ON "GraphRelation"("kbId", "relationType");
CREATE INDEX "GraphRelation_sourceId_idx" ON "GraphRelation"("sourceId");
CREATE INDEX "GraphRelation_targetId_idx" ON "GraphRelation"("targetId");
CREATE INDEX "GraphCommunity_kbId_level_idx" ON "GraphCommunity"("kbId", "level");

ALTER TABLE "GraphRelation" ADD CONSTRAINT "GraphRelation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "GraphEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphRelation" ADD CONSTRAINT "GraphRelation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "GraphEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
