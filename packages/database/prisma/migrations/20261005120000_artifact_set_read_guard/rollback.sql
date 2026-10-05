-- Restore the original (slower) read guards without touching data or manifests.
BEGIN;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['GraphEntity','GraphRelation','GraphCommunity','RaptorNode'] LOOP
  EXECUTE format('DROP POLICY artifact_inputs_guard ON %I',table_name);
  EXECUTE format('CREATE POLICY artifact_inputs_guard ON %I AS RESTRICTIVE FOR SELECT USING (app_is_service() OR app_artifact_readable(id::text,"kbId"))',table_name);
 END LOOP;
END $$;
DROP POLICY artifact_manifest_reader ON "ArtifactManifest";
CREATE POLICY artifact_manifest_reader ON "ArtifactManifest" FOR SELECT USING (
 app_is_service() OR app_artifact_readable("artifactId",(SELECT d."kbId" FROM "ArtifactDependency" a JOIN "Document" d ON d.id=a."sourceDocumentId" WHERE a."artifactId"="ArtifactManifest"."artifactId" LIMIT 1))
);
DROP FUNCTION app_readable_artifacts();
DROP FUNCTION IF EXISTS app_readable_artifacts(text);
COMMIT;
