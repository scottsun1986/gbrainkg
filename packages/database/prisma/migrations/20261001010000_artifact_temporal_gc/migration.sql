CREATE OR REPLACE FUNCTION app_artifact_readable(p_id text,p_kb uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app_current_user_id() IS NOT NULL AND p_kb IN(SELECT app_visible_kb_ids())
 AND EXISTS(SELECT 1 FROM "ArtifactManifest" m WHERE m."artifactId"=p_id AND m."expectedCount"=(SELECT count(*) FROM "ArtifactDependency" a WHERE a."artifactId"=p_id))
 AND NOT EXISTS(SELECT 1 FROM "ArtifactDependency" a LEFT JOIN "Document" d ON d.id=a."sourceDocumentId"
  WHERE a."artifactId"=p_id AND (d.id IS NULL OR d.status<>'published' OR d."kbId"<>p_kb
   OR d."activeVersionId" IS DISTINCT FROM a."sourceVersionId" OR COALESCE(d."contentHash",'') || ':' || d.version::text<>a."sourceHash"
   OR NOT app_document_readable(d.id,d."kbId")
   OR d."effectiveFrom">COALESCE(NULLIF(current_setting('app.as_of',true),'')::timestamptz,statement_timestamp())
   OR d."effectiveTo"<=COALESCE(NULLIF(current_setting('app.as_of',true),'')::timestamptz,statement_timestamp())
   OR (d."lifecycleStatus"='repealed' AND d."effectiveTo" IS NULL)));
$$;
CREATE FUNCTION app_cleanup_artifact_manifest() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN DELETE FROM "ArtifactDependency" WHERE "artifactId"=OLD.id::text;DELETE FROM "ArtifactManifest" WHERE "artifactId"=OLD.id::text;RETURN OLD;END $$;
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['GraphEntity','GraphRelation','GraphCommunity','RaptorNode'] LOOP
  EXECUTE format('CREATE TRIGGER artifact_dependency_gc AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_cleanup_artifact_manifest()',name);
 END LOOP;
END $$;
