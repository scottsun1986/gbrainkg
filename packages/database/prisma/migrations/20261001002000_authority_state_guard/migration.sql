-- Only the SECURITY DEFINER mutation trigger may advance authority state.
ALTER TABLE "AuthorizationState" ENABLE ROW LEVEL SECURITY;
CREATE POLICY authorization_state_reader ON "AuthorizationState" FOR SELECT USING (true);
DROP POLICY artifact_manifest_reader ON "ArtifactManifest";
CREATE POLICY artifact_manifest_reader ON "ArtifactManifest" FOR SELECT USING (
 app_is_service() OR app_artifact_readable("artifactId",(SELECT d."kbId" FROM "ArtifactDependency" a JOIN "Document" d ON d.id=a."sourceDocumentId" WHERE a."artifactId"="ArtifactManifest"."artifactId" LIMIT 1))
);
