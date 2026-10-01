-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "activeVersionId" UUID,
ADD COLUMN     "buildingVersionId" UUID,
ADD COLUMN     "ingestVersion" INTEGER DEFAULT 1,
ADD COLUMN     "pendingContentHash" TEXT,
ADD COLUMN     "pendingRawFileOid" TEXT,
ADD COLUMN     "pendingTitle" TEXT;

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'parsed',
    "sourceHash" TEXT,
    "parserFingerprint" TEXT NOT NULL,
    "chunkerFingerprint" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "mdPath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publicationData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockArtifact" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "ord" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "rawHash" TEXT NOT NULL,
    "indexTextHash" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "BlockArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexGeneration" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "modelFingerprint" TEXT NOT NULL,
    "projectionFingerprint" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "expectedCount" INTEGER NOT NULL,
    "readyCount" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "IndexGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactDependency" (
    "id" UUID NOT NULL,
    "artifactId" TEXT NOT NULL,
    "artifactKind" TEXT NOT NULL,
    "sourceDocumentId" UUID NOT NULL,
    "sourceVersionId" UUID,
    "sourceBlockId" UUID,
    "sourceHash" TEXT NOT NULL,

    CONSTRAINT "ArtifactDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentVersion_state_createdAt_idx" ON "DocumentVersion"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_number_key" ON "DocumentVersion"("documentId", "number");

-- CreateIndex
CREATE INDEX "BlockArtifact_indexTextHash_idx" ON "BlockArtifact"("indexTextHash");

-- CreateIndex
CREATE UNIQUE INDEX "BlockArtifact_versionId_ord_key" ON "BlockArtifact"("versionId", "ord");

-- CreateIndex
CREATE UNIQUE INDEX "IndexGeneration_versionId_channel_modelFingerprint_projecti_key" ON "IndexGeneration"("versionId", "channel", "modelFingerprint", "projectionFingerprint");

-- CreateIndex
CREATE INDEX "ArtifactDependency_artifactId_artifactKind_idx" ON "ArtifactDependency"("artifactId", "artifactKind");

-- CreateIndex
CREATE INDEX "ArtifactDependency_sourceDocumentId_idx" ON "ArtifactDependency"("sourceDocumentId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_buildingVersionId_fkey" FOREIGN KEY ("buildingVersionId") REFERENCES "DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockArtifact" ADD CONSTRAINT "BlockArtifact_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "BlockArtifact" ADD COLUMN embedding vector(1024), ADD COLUMN embedding_fingerprint text;
CREATE INDEX block_artifact_embedding_reuse ON "BlockArtifact" (embedding_fingerprint,"indexTextHash") WHERE embedding IS NOT NULL;
UPDATE "Document" SET "ingestVersion"=version;
-- Backfill preserves the active projection and original Chunk IDs for historical citations.
INSERT INTO "DocumentVersion" (id,"documentId",number,state,"sourceHash","parserFingerprint","chunkerFingerprint","manifestHash","mdPath",title,"publicationData","createdAt","publishedAt")
SELECT md5(id::text || ':v' || version::text)::uuid,id,version,'published',"contentHash",COALESCE("parserEngine",'legacy'),'legacy','legacy',"mdPath",title,'{}',"createdAt",now()
FROM "Document" WHERE status='published';
UPDATE "Document" d SET "activeVersionId"=v.id FROM "DocumentVersion" v WHERE v."documentId"=d.id;
INSERT INTO "BlockArtifact" (id,"versionId",ord,content,"tokenCount","charStart","charEnd","rawHash","indexTextHash",metadata,embedding,embedding_fingerprint)
SELECT c.id,d."activeVersionId",c.ord,c.content,c."tokenCount",c."charStart",c."charEnd",md5(c.content),md5(c.content),c.metadata,c.embedding,c.embedding_fingerprint
FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId" WHERE d."activeVersionId" IS NOT NULL;
ALTER TABLE "DocumentVersion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY core_versions_read ON "DocumentVersion" FOR SELECT USING (app_is_service() OR (state='published' AND EXISTS (SELECT 1 FROM "Document" d WHERE d.id="documentId" AND app_document_readable(d.id,d."kbId"))));
CREATE POLICY core_versions_write ON "DocumentVersion" FOR ALL USING (app_is_service()) WITH CHECK (app_is_service());
ALTER TABLE "BlockArtifact" ENABLE ROW LEVEL SECURITY;
CREATE POLICY core_blocks_read ON "BlockArtifact" FOR SELECT USING (app_is_service() OR EXISTS (SELECT 1 FROM "DocumentVersion" v WHERE v.id="versionId"));
CREATE POLICY core_blocks_write ON "BlockArtifact" FOR ALL USING (app_is_service()) WITH CHECK (app_is_service());
ALTER TABLE "IndexGeneration" ENABLE ROW LEVEL SECURITY;
CREATE POLICY core_generations ON "IndexGeneration" USING (app_is_service() OR EXISTS (SELECT 1 FROM "DocumentVersion" v WHERE v.id="versionId")) WITH CHECK (app_is_service());
ALTER TABLE "ArtifactDependency" ENABLE ROW LEVEL SECURITY;
CREATE POLICY core_dependencies ON "ArtifactDependency" USING (app_is_service() OR EXISTS (SELECT 1 FROM "Document" d WHERE d.id="sourceDocumentId" AND app_document_readable(d.id,d."kbId"))) WITH CHECK (app_is_service());
