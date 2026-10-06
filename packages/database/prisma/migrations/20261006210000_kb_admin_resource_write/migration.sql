BEGIN;

-- Administrator assignment is a resource permission, not read visibility.
-- The industry creator and current resource administrators can assign admins;
-- organization activation assigns admins within the caller's managed subtree.
-- The resource branch never authorizes a personal library.
CREATE FUNCTION app_current_user_can_assign_kb_admin(p_kb uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."KnowledgeBase" k
    JOIN public."User" u ON u.id = public.app_current_user_id() AND u.status = 'active'
    WHERE k.id = p_kb AND k.status = 'active' AND (
      (k.type = 'industry' AND (
        k."ownerUserId" = u.id OR EXISTS (
          SELECT 1 FROM public."KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = u.id
        )
      ))
      OR (k.type = 'org' AND public.app_kb_manages_org(u.id, k."orgNodeId"))
    )
  )
$$;
REVOKE ALL ON FUNCTION app_current_user_can_assign_kb_admin(uuid) FROM PUBLIC;
-- Policy helpers must be executable by runtime callers. PUBLIC execute is
-- intentional (not a restricted grant); results derive from session identity.
GRANT EXECUTE ON FUNCTION app_current_user_can_assign_kb_admin(uuid) TO PUBLIC;

-- FOR ALL conflated reading with deletion: DELETE ignores WITH CHECK, so the
-- old visible-KB branch allowed ordinary readers to delete admin mappings.
DROP POLICY kb_admin_rw ON "KbAdmin";
CREATE POLICY kb_admin_read ON "KbAdmin" FOR SELECT USING (
  app_is_service() OR "userId" = app_current_user_id()
  OR app_current_user_is_system_admin()
  OR app_current_user_can_assign_kb_admin("kbId")
  OR "kbId" IN (SELECT app_visible_kb_ids())
);
CREATE POLICY kb_admin_insert ON "KbAdmin" FOR INSERT WITH CHECK (
  app_is_service() OR app_current_user_is_system_admin()
  OR app_current_user_can_assign_kb_admin("kbId")
);
CREATE POLICY kb_admin_delete ON "KbAdmin" FOR DELETE USING (
  app_is_service() OR app_current_user_is_system_admin()
  OR app_current_user_can_assign_kb_admin("kbId")
);
-- There is no request path updating a mapping's composite key in place.
CREATE POLICY kb_admin_system_update ON "KbAdmin" FOR UPDATE
  USING (app_is_service() OR app_current_user_is_system_admin())
  WITH CHECK (app_is_service() OR app_current_user_is_system_admin());

COMMIT;
