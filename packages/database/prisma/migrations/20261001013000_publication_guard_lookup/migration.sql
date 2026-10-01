-- Avoid re-applying Document RLS inside each Chunk policy evaluation. The
-- definer performs the same publication + live ACL check against the parent.
CREATE FUNCTION public.app_published_document_readable(p_document uuid, p_kb uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
  SELECT app_is_service() OR EXISTS (
    SELECT 1 FROM "Document" d
    WHERE d.id=p_document AND d."kbId"=p_kb AND d.status='published'
      AND app_document_readable(d.id,d."kbId")
  );
$$;
DROP POLICY chunk_publication_guard ON "Chunk";
CREATE POLICY chunk_publication_guard ON "Chunk" AS RESTRICTIVE FOR SELECT
USING (app_published_document_readable("documentId","kbId"));
