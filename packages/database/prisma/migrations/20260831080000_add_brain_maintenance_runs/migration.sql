CREATE TABLE IF NOT EXISTS "BrainMaintenanceRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE INDEX IF NOT EXISTS "BrainMaintenanceRun_startedAt_idx" ON "BrainMaintenanceRun"("startedAt");
CREATE INDEX IF NOT EXISTS "BrainMaintenanceRun_status_startedAt_idx" ON "BrainMaintenanceRun"("status", "startedAt");
