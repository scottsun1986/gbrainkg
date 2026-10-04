-- 20261004120000_chat_run
--
-- Backing table for non-streaming question/answer runs. The client POSTs a
-- question, gets a run id back, and polls it for `stage` until it completes;
-- the sidebar marks conversations whose run is still running.
--
-- State lives in Postgres rather than process memory so a poll that lands on
-- the other instance (production runs inst1 + inst2) still sees the run.
--
-- Tenant isolation follows "Message": a row is visible when its conversation
-- belongs to the calling user, or when the caller is the service role.

CREATE TABLE IF NOT EXISTS "ChatRun" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL,
  "userId"         UUID NOT NULL,
  "messageId"      UUID,
  "status"         TEXT NOT NULL DEFAULT 'running',
  "stage"          TEXT NOT NULL DEFAULT 'queued',
  "errorMessage"   TEXT,
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),
  CONSTRAINT "ChatRun_conversationId_fkey" FOREIGN KEY ("conversationId")
    REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ChatRun_userId_status_startedAt_idx" ON "ChatRun"("userId", "status", "startedAt");
CREATE INDEX IF NOT EXISTS "ChatRun_conversationId_startedAt_idx" ON "ChatRun"("conversationId", "startedAt");

ALTER TABLE "ChatRun" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chatrun_rw ON "ChatRun";
CREATE POLICY chatrun_rw ON "ChatRun" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "conversationId" IN (
    SELECT id FROM "Conversation" WHERE "userId" = app_current_user_id()
  ))
)
WITH CHECK (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "conversationId" IN (
    SELECT id FROM "Conversation" WHERE "userId" = app_current_user_id()
  ))
);

-- Only the runtime role(s) get table privileges; HTTP identities stay behind RLS.
DO $$ DECLARE candidates text[];runtime text;BEGIN
 candidates:=CASE WHEN current_database()='llmwiki' THEN ARRAY['llmwiki_app','llmwiki_app_inst1']
  WHEN current_database()~'^llmwiki_inst[0-9]+$' THEN ARRAY[replace(current_database(),'llmwiki_inst','llmwiki_app_inst')]
  ELSE ARRAY[]::text[] END;
 FOR runtime IN SELECT rolname FROM pg_roles WHERE rolname=ANY(candidates) LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe runtime role %',runtime;END IF;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO %I','ChatRun',runtime);
 END LOOP;
END $$;
