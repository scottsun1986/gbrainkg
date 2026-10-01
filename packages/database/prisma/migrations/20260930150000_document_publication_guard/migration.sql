-- Content and cache readers must observe withdrawal/deletion immediately.
DROP TRIGGER core_document_auth_revision ON "Document";
CREATE TRIGGER core_document_auth_revision AFTER UPDATE OF "aclMode",status,"activeVersionId","contentHash","effectiveFrom","effectiveTo","lifecycleStatus" ON "Document"
FOR EACH STATEMENT EXECUTE FUNCTION app_auth_changed();
CREATE TRIGGER core_document_delete_revision AFTER DELETE ON "Document"
FOR EACH STATEMENT EXECUTE FUNCTION app_auth_changed();

CREATE OR REPLACE FUNCTION app_document_write(p_kb uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app_is_service() OR EXISTS(SELECT 1 FROM "KnowledgeBase" k JOIN "User" u ON u.id=app_current_user_id() AND u.status='active'
   WHERE k.id=p_kb AND app_kb_can_manage(k.id,k.type,k."ownerUserId",k."orgNodeId"));
$$;
DROP POLICY IF EXISTS doc_rw ON "Document";
CREATE POLICY doc_content_read ON "Document" FOR SELECT USING (
  app_is_service() OR (status='published' AND app_document_readable(id,"kbId")) OR app_document_write("kbId"));
CREATE POLICY doc_content_write ON "Document" FOR ALL USING(app_document_write("kbId")) WITH CHECK(app_document_write("kbId"));
-- A restrictive policy intersects all existing chunk/posting read policies.
CREATE POLICY chunk_publication_guard ON "Chunk" AS RESTRICTIVE FOR SELECT USING(
  app_is_service() OR EXISTS(SELECT 1 FROM "Document" d WHERE d.id="documentId" AND d.status='published' AND app_document_readable(d.id,d."kbId")));
