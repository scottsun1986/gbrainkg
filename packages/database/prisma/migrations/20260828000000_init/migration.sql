-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgNode" (
    "id" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "OrgNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserOrg" (
    "userId" UUID NOT NULL,
    "orgNodeId" UUID NOT NULL,

    CONSTRAINT "UserOrg_pkey" PRIMARY KEY ("userId","orgNodeId")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "OrgAdmin" (
    "orgNodeId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "OrgAdmin_pkey" PRIMARY KEY ("orgNodeId","userId")
);

-- CreateTable
CREATE TABLE "KnowledgeBase" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" UUID,
    "orgNodeId" UUID,
    "gitRepoUrl" TEXT NOT NULL,
    "embeddingModelId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbAdmin" (
    "kbId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "KbAdmin_pkey" PRIMARY KEY ("kbId","userId")
);

-- CreateTable
CREATE TABLE "IndustryGrant" (
    "id" UUID NOT NULL,
    "kbId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndustryGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "kbId" UUID NOT NULL,
    "mdPath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "rawFileOid" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "gitCommit" TEXT,
    "uploadedById" UUID,
    "status" TEXT NOT NULL DEFAULT 'parsing',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "kbId" UUID NOT NULL,
    "ord" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kbScope" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citationsSummary" JSONB,
    "latencyMs" INTEGER,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "chunkId" UUID,
    "documentId" UUID,
    "kbId" UUID,
    "snippet" TEXT NOT NULL,

    CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainRepo" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gitRepoUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastCompileAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainTopic" (
    "id" UUID NOT NULL,
    "brainRepoId" UUID NOT NULL,
    "topicSlug" TEXT NOT NULL,
    "mdPath" TEXT NOT NULL,
    "compileStatus" TEXT NOT NULL DEFAULT 'clean',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "dirtySource" TEXT,
    "dirtyDocIds" JSONB,
    "lastCompiledAt" TIMESTAMP(3),
    "dirtySince" TIMESTAMP(3),

    CONSTRAINT "BrainTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainSource" (
    "id" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainSourceMember" (
    "sourceId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "BrainSourceMember_pkey" PRIMARY KEY ("sourceId","userId")
);

-- CreateTable
CREATE TABLE "BrainSourceDocument" (
    "sourceId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "syncedVersion" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainSourceDocument_pkey" PRIMARY KEY ("sourceId","documentId")
);

-- CreateTable
CREATE TABLE "BrainScope" (
    "id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "name" TEXT,
    "sourceKeys" JSONB NOT NULL DEFAULT '[]',
    "aclEpoch" INTEGER NOT NULL DEFAULT 1,
    "knowledgeEpoch" INTEGER NOT NULL DEFAULT 1,
    "strategy" TEXT NOT NULL DEFAULT 'eager',
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastCompileAt" TIMESTAMP(3),
    "lastAccessAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainScopeMember" (
    "scopeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainScopeMember_pkey" PRIMARY KEY ("scopeId","userId")
);

-- CreateTable
CREATE TABLE "BrainDerivedPage" (
    "id" UUID NOT NULL,
    "scopeId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'summary',
    "content" TEXT NOT NULL,
    "derivedFrom" JSONB NOT NULL DEFAULT '[]',
    "inputFingerprint" TEXT NOT NULL,
    "modelVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainDerivedPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainChangeEvent" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "payload" JSONB DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "affectedScopes" JSONB DEFAULT '[]',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BrainChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainOperationLog" (
    "id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "scopeId" TEXT,
    "phase" TEXT,
    "counts" JSONB DEFAULT '{}',
    "durationMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'success',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainOperationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainMaintenanceRun" (
    "id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "sourcesVisited" INTEGER NOT NULL DEFAULT 0,
    "sourcesSucceeded" INTEGER NOT NULL DEFAULT 0,
    "sourcesPartial" INTEGER NOT NULL DEFAULT 0,
    "syncedDocs" INTEGER NOT NULL DEFAULT 0,
    "removedDocs" INTEGER NOT NULL DEFAULT 0,
    "queuedTopics" INTEGER NOT NULL DEFAULT 0,
    "sourceResults" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "BrainMaintenanceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompileJob" (
    "id" UUID NOT NULL,
    "brainTopicId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "inputEvidenceIds" JSONB,
    "truthDiff" TEXT,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "gitCommit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CompileJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEncrypted" BYTEA,
    "defaultParams" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelConfig" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'llm',
    "modelName" TEXT NOT NULL,
    "contextLen" INTEGER NOT NULL,
    "dimensions" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "testStatus" TEXT NOT NULL DEFAULT 'untested',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbModelOverride" (
    "id" UUID NOT NULL,
    "kbId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "modelConfigId" UUID NOT NULL,

    CONSTRAINT "KbModelOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" UUID,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "OrgNode_parentId_idx" ON "OrgNode"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE INDEX "KnowledgeBase_ownerUserId_idx" ON "KnowledgeBase"("ownerUserId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_orgNodeId_idx" ON "KnowledgeBase"("orgNodeId");

-- CreateIndex
CREATE INDEX "KnowledgeBase_type_status_idx" ON "KnowledgeBase"("type", "status");

-- CreateIndex
CREATE INDEX "IndustryGrant_kbId_subjectType_subjectId_idx" ON "IndustryGrant"("kbId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "IndustryGrant_expiresAt_idx" ON "IndustryGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "Document_kbId_status_idx" ON "Document"("kbId", "status");

-- CreateIndex
CREATE INDEX "Chunk_kbId_documentId_idx" ON "Chunk"("kbId", "documentId");

-- CreateIndex
CREATE INDEX "Conversation_userId_idx" ON "Conversation"("userId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Citation_messageId_idx" ON "Citation"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "BrainRepo_userId_key" ON "BrainRepo"("userId");

-- CreateIndex
CREATE INDEX "BrainTopic_brainRepoId_compileStatus_idx" ON "BrainTopic"("brainRepoId", "compileStatus");

-- CreateIndex
CREATE UNIQUE INDEX "BrainTopic_brainRepoId_topicSlug_key" ON "BrainTopic"("brainRepoId", "topicSlug");

-- CreateIndex
CREATE UNIQUE INDEX "BrainSource_sourceKey_key" ON "BrainSource"("sourceKey");

-- CreateIndex
CREATE INDEX "BrainSource_kind_status_idx" ON "BrainSource"("kind", "status");

-- CreateIndex
CREATE INDEX "BrainSourceMember_userId_idx" ON "BrainSourceMember"("userId");

-- CreateIndex
CREATE INDEX "BrainSourceDocument_documentId_idx" ON "BrainSourceDocument"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "BrainScope_fingerprint_key" ON "BrainScope"("fingerprint");

-- CreateIndex
CREATE INDEX "BrainScope_fingerprint_idx" ON "BrainScope"("fingerprint");

-- CreateIndex
CREATE INDEX "BrainScope_status_idx" ON "BrainScope"("status");

-- CreateIndex
CREATE INDEX "BrainScope_lastAccessAt_idx" ON "BrainScope"("lastAccessAt");

-- CreateIndex
CREATE INDEX "BrainScopeMember_userId_idx" ON "BrainScopeMember"("userId");

-- CreateIndex
CREATE INDEX "BrainDerivedPage_scopeId_kind_idx" ON "BrainDerivedPage"("scopeId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "BrainDerivedPage_scopeId_slug_key" ON "BrainDerivedPage"("scopeId", "slug");

-- CreateIndex
CREATE INDEX "BrainChangeEvent_status_createdAt_idx" ON "BrainChangeEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BrainChangeEvent_eventType_resourceId_idx" ON "BrainChangeEvent"("eventType", "resourceId");

-- CreateIndex
CREATE INDEX "BrainOperationLog_operation_createdAt_idx" ON "BrainOperationLog"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "BrainOperationLog_scopeId_createdAt_idx" ON "BrainOperationLog"("scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "BrainMaintenanceRun_startedAt_idx" ON "BrainMaintenanceRun"("startedAt");

-- CreateIndex
CREATE INDEX "BrainMaintenanceRun_status_startedAt_idx" ON "BrainMaintenanceRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "CompileJob_userId_status_createdAt_idx" ON "CompileJob"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CompileJob_status_createdAt_idx" ON "CompileJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KbModelOverride_kbId_kind_key" ON "KbModelOverride"("kbId", "kind");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_resourceId_idx" ON "AuditLog"("resourceId");

-- AddForeignKey
ALTER TABLE "OrgNode" ADD CONSTRAINT "OrgNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OrgNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOrg" ADD CONSTRAINT "UserOrg_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOrg" ADD CONSTRAINT "UserOrg_orgNodeId_fkey" FOREIGN KEY ("orgNodeId") REFERENCES "OrgNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgAdmin" ADD CONSTRAINT "OrgAdmin_orgNodeId_fkey" FOREIGN KEY ("orgNodeId") REFERENCES "OrgNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgAdmin" ADD CONSTRAINT "OrgAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_orgNodeId_fkey" FOREIGN KEY ("orgNodeId") REFERENCES "OrgNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbAdmin" ADD CONSTRAINT "KbAdmin_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbAdmin" ADD CONSTRAINT "KbAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndustryGrant" ADD CONSTRAINT "IndustryGrant_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainRepo" ADD CONSTRAINT "BrainRepo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainTopic" ADD CONSTRAINT "BrainTopic_brainRepoId_fkey" FOREIGN KEY ("brainRepoId") REFERENCES "BrainRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainSourceMember" ADD CONSTRAINT "BrainSourceMember_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BrainSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainSourceMember" ADD CONSTRAINT "BrainSourceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainSourceDocument" ADD CONSTRAINT "BrainSourceDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BrainSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainSourceDocument" ADD CONSTRAINT "BrainSourceDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainScopeMember" ADD CONSTRAINT "BrainScopeMember_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "BrainScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainScopeMember" ADD CONSTRAINT "BrainScopeMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrainDerivedPage" ADD CONSTRAINT "BrainDerivedPage_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "BrainScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompileJob" ADD CONSTRAINT "CompileJob_brainTopicId_fkey" FOREIGN KEY ("brainTopicId") REFERENCES "BrainTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompileJob" ADD CONSTRAINT "CompileJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelConfig" ADD CONSTRAINT "ModelConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbModelOverride" ADD CONSTRAINT "KbModelOverride_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbModelOverride" ADD CONSTRAINT "KbModelOverride_modelConfigId_fkey" FOREIGN KEY ("modelConfigId") REFERENCES "ModelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

