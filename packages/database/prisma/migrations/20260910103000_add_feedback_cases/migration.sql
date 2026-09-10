-- Bad-case feedback flywheel: user-flagged answers become regression cases.
CREATE TABLE "FeedbackCase" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "evidence" JSONB,
    "trace" JSONB,
    "correction" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FeedbackCase_messageId_idx" ON "FeedbackCase"("messageId");
CREATE INDEX "FeedbackCase_status_createdAt_idx" ON "FeedbackCase"("status", "createdAt");
CREATE INDEX "FeedbackCase_userId_createdAt_idx" ON "FeedbackCase"("userId", "createdAt");

ALTER TABLE "FeedbackCase" ADD CONSTRAINT "FeedbackCase_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "FeedbackCase" ADD CONSTRAINT "FeedbackCase_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON UPDATE CASCADE ON DELETE CASCADE;
