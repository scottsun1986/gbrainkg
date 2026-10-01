ALTER TABLE "SemanticCache" ADD COLUMN "dependencyManifest" jsonb;

CREATE OR REPLACE FUNCTION app_document_acl_manage(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM "Document" d JOIN "KnowledgeBase" kb ON kb.id=d."kbId"
    JOIN "User" u ON u.id=app_current_user_id() AND u.status='active'
    WHERE d.id=p_id AND (kb."ownerUserId"=u.id
      OR (kb.type<>'personal' AND app_system_admin(u.id))
      OR EXISTS(SELECT 1 FROM "KbAdmin" a WHERE a."kbId"=kb.id AND a."userId"=u.id)));
$$;
DROP POLICY IF EXISTS doc_acl_rw ON "DocumentAcl";
DROP POLICY IF EXISTS doc_acl_read ON "DocumentAcl";
DROP POLICY IF EXISTS doc_acl_insert ON "DocumentAcl";
DROP POLICY IF EXISTS doc_acl_update ON "DocumentAcl";
DROP POLICY IF EXISTS doc_acl_delete ON "DocumentAcl";
CREATE OR REPLACE FUNCTION app_can_manage_document_acl(p_document_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT app_is_service() OR app_document_acl_manage(p_document_id);
$$;
CREATE POLICY document_acl_read ON "DocumentAcl" FOR SELECT
  USING (app_is_service() OR app_document_acl_manage("documentId") OR app_document_readable("documentId",(SELECT "kbId" FROM "Document" WHERE id="documentId")));
CREATE POLICY document_acl_manage ON "DocumentAcl" FOR ALL
  USING (app_is_service() OR app_document_acl_manage("documentId"))
  WITH CHECK (app_is_service() OR app_document_acl_manage("documentId"));
