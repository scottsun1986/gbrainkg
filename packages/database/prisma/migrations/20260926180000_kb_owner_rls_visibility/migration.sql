-- Allow an authenticated creator to read back their own KB row during INSERT
-- ... RETURNING, before membership reconciliation has populated the derived
-- visible-KB set. This keeps KB creation compatible with NOBYPASSRLS runtime
-- roles while preserving visibility isolation for every other row.
DROP POLICY IF EXISTS kb_rw ON "KnowledgeBase";
CREATE POLICY kb_rw ON "KnowledgeBase" FOR ALL
USING (
  app_is_service()
  OR (
    app_current_user_id() IS NOT NULL
    AND (
      id IN (SELECT app_visible_kb_ids())
      OR "ownerUserId" = app_current_user_id()
    )
  )
)
WITH CHECK (
  app_is_service()
  OR app_current_user_id() IS NOT NULL
);
