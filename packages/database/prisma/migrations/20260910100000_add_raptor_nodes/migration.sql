-- RAPTOR recursive summary tree nodes.
CREATE TABLE "RaptorNode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kbId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "parentNodeId" UUID,
    "level" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceChunkIds" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaptorNode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RaptorNode_kbId_level_idx" ON "RaptorNode"("kbId", "level");
CREATE INDEX "RaptorNode_documentId_idx" ON "RaptorNode"("documentId");
CREATE INDEX "RaptorNode_documentId_level_idx" ON "RaptorNode"("documentId", "level");
CREATE INDEX "RaptorNode_parentNodeId_idx" ON "RaptorNode"("parentNodeId");

ALTER TABLE "RaptorNode" ADD CONSTRAINT "RaptorNode_kbId_fkey"
    FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RaptorNode" ADD CONSTRAINT "RaptorNode_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON UPDATE CASCADE ON DELETE CASCADE;
