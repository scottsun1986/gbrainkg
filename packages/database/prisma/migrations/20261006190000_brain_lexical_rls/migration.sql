BEGIN;
-- C-04 remainder: the brain, lexical and cache tables. These are the ones where
-- a naive service-only policy would be wrong — retrieval reads the lexical and
-- sparse tables *inside a user request*, so they must be scoped by what the
-- caller can read, not by service context.

CREATE FUNCTION app_current_user_scope_ids() RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT m."scopeId" FROM "BrainScopeMember" m
  WHERE m."userId"=app_current_user_id()
    AND m."validFrom"<=statement_timestamp()
    AND (m."validTo" IS NULL OR m."validTo">statement_timestamp())
$$;

CREATE FUNCTION app_current_user_source_ids() RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT m."sourceId" FROM "BrainSourceMember" m WHERE m."userId"=app_current_user_id()
$$;

-- Chunk has its own forced RLS; resolve readability through a definer helper so
-- the policy does not depend on how Chunk's own policy is written.
CREATE FUNCTION app_current_user_chunk_readable(p_chunk uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS (SELECT 1 FROM "Chunk" c
  WHERE c.id=p_chunk AND app_document_readable(c."documentId",c."kbId"))
$$;

-- See 20261006180000: parameterless/caller-derived helpers must stay PUBLIC so a
-- policy nested inside another policy's subquery can still execute them.
REVOKE ALL ON FUNCTION app_current_user_scope_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_scope_ids() TO PUBLIC;
REVOKE ALL ON FUNCTION app_current_user_source_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_source_ids() TO PUBLIC;
REVOKE ALL ON FUNCTION app_current_user_chunk_readable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_chunk_readable(uuid) TO PUBLIC;

DO $$
DECLARE runtime_role text; candidate_roles text[];
BEGIN
 candidate_roles := CASE
  WHEN current_database() = 'llmwiki' THEN ARRAY['llmwiki_app','llmwiki_app_inst1']
  WHEN current_database() ~ '^llmwiki_inst[0-9]+$'
   THEN ARRAY[replace(current_database(),'llmwiki_inst','llmwiki_app_inst')]
  ELSE NULL END;
 IF candidate_roles IS NULL THEN RETURN; END IF;
 FOREACH runtime_role IN ARRAY candidate_roles LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_user_scope_ids() TO %I',runtime_role);
   EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_user_source_ids() TO %I',runtime_role);
   EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_user_chunk_readable(uuid) TO %I',runtime_role);
  END IF;
 END LOOP;
END $$;

-- 1. Retrieval-side tables: scoped by what the caller may read.
ALTER TABLE "ChunkLexicalDoc" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChunkLexicalDoc" FORCE ROW LEVEL SECURITY;
CREATE POLICY chunk_lexical_read ON "ChunkLexicalDoc" FOR SELECT USING (
 app_is_service() OR app_document_readable("documentId","kbId"));
CREATE POLICY chunk_lexical_write ON "ChunkLexicalDoc" FOR ALL
 USING (app_is_service() OR app_document_readable("documentId","kbId"))
 WITH CHECK (app_is_service() OR app_document_readable("documentId","kbId"));

ALTER TABLE "ChunkSparseEmbedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChunkSparseEmbedding" FORCE ROW LEVEL SECURITY;
CREATE POLICY chunk_sparse_read ON "ChunkSparseEmbedding" FOR SELECT USING (
 app_is_service() OR app_current_user_chunk_readable("chunkId"));
CREATE POLICY chunk_sparse_write ON "ChunkSparseEmbedding" FOR ALL
 USING (app_is_service() OR app_current_user_chunk_readable("chunkId"))
 WITH CHECK (app_is_service() OR app_current_user_chunk_readable("chunkId"));

ALTER TABLE "KbLexicalStat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KbLexicalStat" FORCE ROW LEVEL SECURITY;
CREATE POLICY kb_lexical_stat_read ON "KbLexicalStat" FOR SELECT USING (
 app_is_service() OR "kbId" IN (SELECT app_visible_kb_ids()));
-- Written from ordinary request paths too: deleting a document updates the KB's
-- postings and statistics under the caller's context, so a service-only write
-- policy turned deletion into a 500 (RLS violation). Scope writes by the same
-- readability predicate the reads use.
CREATE POLICY kb_lexical_stat_write ON "KbLexicalStat" FOR ALL
 USING (app_is_service() OR "kbId" IN (SELECT app_visible_kb_ids()))
 WITH CHECK (app_is_service() OR "kbId" IN (SELECT app_visible_kb_ids()));

ALTER TABLE "LexicalTermStat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LexicalTermStat" FORCE ROW LEVEL SECURITY;
CREATE POLICY lexical_term_stat_read ON "LexicalTermStat" FOR SELECT USING (
 app_is_service() OR "kbId" IN (SELECT app_visible_kb_ids()));
CREATE POLICY lexical_term_stat_write ON "LexicalTermStat" FOR ALL
 USING (app_is_service() OR "kbId" IN (SELECT app_visible_kb_ids()))
 WITH CHECK (app_is_service() OR "kbId" IN (SELECT app_visible_kb_ids()));

-- 2. Per-user brain state: the owner, or service.
ALTER TABLE "BrainRepo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainRepo" FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_repo_rw ON "BrainRepo" FOR ALL
 USING (app_is_service() OR "userId"=app_current_user_id())
 WITH CHECK (app_is_service() OR "userId"=app_current_user_id());

ALTER TABLE "CompileJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CompileJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY compile_job_rw ON "CompileJob" FOR ALL
 USING (app_is_service() OR "userId"=app_current_user_id())
 WITH CHECK (app_is_service() OR "userId"=app_current_user_id());

ALTER TABLE "BrainTopic" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainTopic" FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_topic_rw ON "BrainTopic" FOR ALL
 USING (app_is_service() OR EXISTS (
   SELECT 1 FROM "BrainRepo" r WHERE r.id="BrainTopic"."brainRepoId" AND r."userId"=app_current_user_id()))
 WITH CHECK (app_is_service() OR EXISTS (
   SELECT 1 FROM "BrainRepo" r WHERE r.id="BrainTopic"."brainRepoId" AND r."userId"=app_current_user_id()));

-- 3. Scoped brain state: scope/source membership.
ALTER TABLE "BrainScope" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainScope" FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_scope_read ON "BrainScope" FOR SELECT USING (
 app_is_service() OR id IN (SELECT app_current_user_scope_ids()));
-- The app materialises a scope/source row lazily from an ordinary request
-- (BrainScopeService.resolveUserScope runs under the caller's context), so a
-- service-only write policy made the first retrieval of every user fail.
CREATE POLICY brain_scope_write ON "BrainScope" FOR ALL
 USING (app_is_service() OR app_current_user_id() IS NOT NULL)
 WITH CHECK (app_is_service() OR app_current_user_id() IS NOT NULL);

ALTER TABLE "BrainSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainSource" FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_source_read ON "BrainSource" FOR SELECT USING (
 app_is_service() OR id IN (SELECT app_current_user_source_ids()));
-- The app materialises a scope/source row lazily from an ordinary request
-- (BrainScopeService.resolveUserScope runs under the caller's context), so a
-- service-only write policy made the first retrieval of every user fail.
CREATE POLICY brain_source_write ON "BrainSource" FOR ALL
 USING (app_is_service() OR app_current_user_id() IS NOT NULL)
 WITH CHECK (app_is_service() OR app_current_user_id() IS NOT NULL);

-- 4. Operational rows: background writes them; administrators read telemetry.
ALTER TABLE "BrainChangeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainChangeEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_change_event_rw ON "BrainChangeEvent" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

ALTER TABLE "BrainOperationLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainOperationLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_operation_log_read ON "BrainOperationLog" FOR SELECT USING (
 app_is_service() OR app_current_user_is_system_admin());
CREATE POLICY brain_operation_log_write ON "BrainOperationLog" FOR ALL
 USING (app_is_service()) WITH CHECK (app_is_service());

ALTER TABLE "BrainMaintenanceRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainMaintenanceRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_maintenance_run_read ON "BrainMaintenanceRun" FOR SELECT USING (
 app_is_service() OR app_current_user_is_system_admin());
CREATE POLICY brain_maintenance_run_write ON "BrainMaintenanceRun" FOR ALL
 USING (app_is_service()) WITH CHECK (app_is_service());

-- 5. Internal ingestion cache, keyed by an opaque key: service only.
ALTER TABLE "ContextualPrefixCache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContextualPrefixCache" FORCE ROW LEVEL SECURITY;
CREATE POLICY contextual_prefix_cache_rw ON "ContextualPrefixCache" FOR ALL
 USING (app_is_service()) WITH CHECK (app_is_service());
COMMIT;
