-- ACL writes are authorized against the target document, rather than granted
-- service-wide access to an HTTP request. The API role remains NOBYPASSRLS.
CREATE OR REPLACE FUNCTION app_can_manage_document_acl(p_document_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS
$$
DECLARE
  v_user uuid := app_current_user_id();
  v_kb uuid;
BEGIN
  IF app_is_service() THEN RETURN true; END IF;
  IF v_user IS NULL THEN RETURN false; END IF;
  SELECT d."kbId" INTO v_kb FROM "Document" d WHERE d.id = p_document_id;
  IF v_kb IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM "KnowledgeBase" k WHERE k.id = v_kb AND k.status = 'active') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
    WHERE ur."userId" = v_user
      AND (r.name IN ('系统管理员', '超级管理员') OR r.permissions::text LIKE '%"*"%')
  ) OR EXISTS (
    SELECT 1 FROM "KnowledgeBase" k WHERE k.id = v_kb AND k."ownerUserId" = v_user
  ) OR EXISTS (
    SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = v_kb AND a."userId" = v_user
  );
END;
$$;

REVOKE ALL ON FUNCTION app_can_manage_document_acl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_can_manage_document_acl(uuid) TO PUBLIC;

DROP POLICY IF EXISTS doc_acl_rw ON "DocumentAcl";
CREATE POLICY doc_acl_read ON "DocumentAcl" FOR SELECT
USING (
  app_is_service() OR
  (app_current_user_id() IS NOT NULL AND
    app_document_readable("documentId", (SELECT "kbId" FROM "Document" WHERE id = "documentId")))
);
CREATE POLICY doc_acl_insert ON "DocumentAcl" FOR INSERT
WITH CHECK (app_can_manage_document_acl("documentId"));
CREATE POLICY doc_acl_update ON "DocumentAcl" FOR UPDATE
USING (app_can_manage_document_acl("documentId"))
WITH CHECK (app_can_manage_document_acl("documentId"));
CREATE POLICY doc_acl_delete ON "DocumentAcl" FOR DELETE
USING (app_can_manage_document_acl("documentId"));
