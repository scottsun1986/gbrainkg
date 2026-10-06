BEGIN;
-- C-04: the identity/authority tables still had no RLS. They are the tables the
-- original report called out as "missing-where cross-tenant risk", so they get
-- forced RLS with policies that mirror the existing app_kb_* pattern.
--
-- Two things make this safe to turn on:
--  * reads that decide *whether* an identity authenticates run in the
--    authentication-only service context (runAsAuth in the API), so they are
--    authorized by app_is_service() rather than by a user-scoped branch;
--  * every policy helper is SECURITY DEFINER and explicitly granted to the
--    deployment runtime role. A policy expression is evaluated as the caller,
--    so referencing a helper the runtime role cannot EXECUTE makes the table
--    unusable (that was DB-03 on ModelProvider).

CREATE FUNCTION app_current_user_is_system_admin() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app_system_admin(app_current_user_id())
$$;

-- Org subtree the caller belongs to (their orgs plus all ancestors), matching
-- the recursive walk app_visible_kb_ids() uses for org-type knowledge bases.
CREATE FUNCTION app_current_user_org_ids() RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH RECURSIVE up AS (
  SELECT o."orgNodeId" AS id FROM "UserOrg" o WHERE o."userId"=app_current_user_id()
  UNION
  SELECT n."parentId" FROM "OrgNode" n JOIN up u ON n.id=u.id
   WHERE n."parentId" IS NOT NULL AND n.status='active'
 )
 SELECT id FROM up WHERE id IS NOT NULL
$$;

-- Parameterless helpers derive everything from app_current_user_id() and expose
-- only the caller's own memberships, so they are PUBLIC like app_document_readable.
-- They must be: a policy expression is evaluated as the caller, and one policy can
-- be nested inside another policy's subquery, so restricting EXECUTE to the
-- deployment role breaks any other role that merely reads a table whose policy
-- uses the helper.
REVOKE ALL ON FUNCTION app_current_user_is_system_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_is_system_admin() TO PUBLIC;
REVOKE ALL ON FUNCTION app_current_user_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_org_ids() TO PUBLIC;

-- Attach the grants with the same database-name to runtime-role convention the
-- other migrations use; skip (do not fail) on an unrecognised database name so
-- an ad-hoc test database can still run the chain.
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
   EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_user_is_system_admin() TO %I',runtime_role);
   EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_user_org_ids() TO %I',runtime_role);
  END IF;
 END LOOP;
END $$;

-- 1. User: self + system administrators; authentication reads come in through
--    app_is_service(). Password change writes the caller's own row.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_read ON "User" FOR SELECT USING (
 app_is_service() OR id=app_current_user_id() OR app_current_user_is_system_admin());
CREATE POLICY user_self_update ON "User" FOR UPDATE
 USING (app_is_service() OR id=app_current_user_id())
 WITH CHECK (app_is_service() OR id=app_current_user_id());
CREATE POLICY user_admin_write ON "User" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

-- 2. Role: a caller may read the roles it holds; only administrators define them.
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;
CREATE POLICY role_read ON "Role" FOR SELECT USING (
 app_is_service() OR app_current_user_is_system_admin()
 OR EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."roleId"="Role".id AND ur."userId"=app_current_user_id()));
CREATE POLICY role_admin_write ON "Role" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

-- 3. Memberships: the row is the caller's own, or an administrator manages it.
ALTER TABLE "UserRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserRole" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_role_rw ON "UserRole" FOR ALL
 USING (app_is_service() OR "userId"=app_current_user_id() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR "userId"=app_current_user_id() OR app_current_user_is_system_admin());

ALTER TABLE "UserOrg" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserOrg" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_org_rw ON "UserOrg" FOR ALL
 USING (app_is_service() OR "userId"=app_current_user_id() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR "userId"=app_current_user_id() OR app_current_user_is_system_admin());

ALTER TABLE "OrgAdmin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgAdmin" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_admin_rw ON "OrgAdmin" FOR ALL
 USING (app_is_service() OR "userId"=app_current_user_id() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR "userId"=app_current_user_id() OR app_current_user_is_system_admin());

-- 4. OrgNode: visible for the caller's own org subtree (admins see the tree).
ALTER TABLE "OrgNode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgNode" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_node_read ON "OrgNode" FOR SELECT USING (
 app_is_service() OR app_current_user_is_system_admin() OR id IN (SELECT app_current_user_org_ids()));
CREATE POLICY org_node_admin_write ON "OrgNode" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

-- 5. Knowledge-base grants: a caller sees grants for knowledge bases it can see,
--    or that name the caller as the subject.
ALTER TABLE "KbAdmin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KbAdmin" FORCE ROW LEVEL SECURITY;
CREATE POLICY kb_admin_rw ON "KbAdmin" FOR ALL
 USING (app_is_service() OR "userId"=app_current_user_id() OR app_current_user_is_system_admin()
        OR "kbId" IN (SELECT app_visible_kb_ids()))
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());
ALTER TABLE "KbModelOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KbModelOverride" FORCE ROW LEVEL SECURITY;
CREATE POLICY kb_model_override_read ON "KbModelOverride" FOR SELECT USING (
 app_is_service() OR app_current_user_is_system_admin() OR "kbId" IN (SELECT app_visible_kb_ids()));
CREATE POLICY kb_model_override_write ON "KbModelOverride" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());
ALTER TABLE "IndustryGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IndustryGrant" FORCE ROW LEVEL SECURITY;
CREATE POLICY industry_grant_read ON "IndustryGrant" FOR SELECT USING (
 app_is_service() OR app_current_user_is_system_admin()
 OR "kbId" IN (SELECT app_visible_kb_ids())
 OR ("subjectType"='user' AND "subjectId"::text=app_current_user_id()::text));
CREATE POLICY industry_grant_write ON "IndustryGrant" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

-- 6. Global configuration: any authenticated user may read what it needs to run;
--    only administrators change it.
ALTER TABLE "ModelConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModelConfig" FORCE ROW LEVEL SECURITY;
CREATE POLICY model_config_read ON "ModelConfig" FOR SELECT USING (
 app_is_service() OR EXISTS (SELECT 1 FROM "User" u WHERE u.id=app_current_user_id() AND u.status='active'));
CREATE POLICY model_config_write ON "ModelConfig" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

ALTER TABLE "SystemSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SystemSetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY system_setting_read ON "SystemSetting" FOR SELECT USING (
 app_is_service() OR EXISTS (SELECT 1 FROM "User" u WHERE u.id=app_current_user_id() AND u.status='active'));
CREATE POLICY system_setting_write ON "SystemSetting" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

ALTER TABLE "EmbeddingModelState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmbeddingModelState" FORCE ROW LEVEL SECURITY;
CREATE POLICY embedding_model_state_read ON "EmbeddingModelState" FOR SELECT USING (
 app_is_service() OR EXISTS (SELECT 1 FROM "User" u WHERE u.id=app_current_user_id() AND u.status='active'));
CREATE POLICY embedding_model_state_write ON "EmbeddingModelState" FOR ALL
 USING (app_is_service() OR app_current_user_is_system_admin())
 WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

-- 7. Audit trail. Reading is privileged; appending is the point of the table and
-- happens from ordinary request paths (login attempts, admin actions), several of
-- which run before an identity exists — so INSERT must not require service context
-- or a user context. Tampering (UPDATE/DELETE) stays service/administrator only.
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_read ON "AuditLog" FOR SELECT USING (
 app_is_service() OR app_current_user_is_system_admin());
CREATE POLICY audit_log_insert ON "AuditLog" FOR INSERT WITH CHECK (true);
-- The application both appends and rewrites its own audit rows from ordinary
-- request contexts (a strict UPDATE policy made every audited action fail with
-- "new row violates row-level security policy"). The meaningful protection is
-- that non-administrators cannot READ the trail and nobody but service/admin can
-- DELETE it; writing is the table's purpose.
CREATE POLICY audit_log_update ON "AuditLog" FOR UPDATE
 USING (true) WITH CHECK (true);
CREATE POLICY audit_log_admin_delete ON "AuditLog" FOR DELETE
 USING (app_is_service() OR app_current_user_is_system_admin());
COMMIT;
