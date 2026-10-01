CREATE TABLE "GraphProjectionInput" (
 "documentId" uuid PRIMARY KEY REFERENCES "Document"(id) ON DELETE CASCADE,
 "kbId" uuid NOT NULL REFERENCES "KnowledgeBase"(id) ON DELETE CASCADE,
 fingerprint text NOT NULL, payload jsonb NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX graph_projection_kb ON "GraphProjectionInput"("kbId");
ALTER TABLE "GraphProjectionInput" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GraphProjectionInput" FORCE ROW LEVEL SECURITY;
CREATE POLICY graph_projection_service ON "GraphProjectionInput" FOR ALL USING(app_is_service()) WITH CHECK(app_is_service());
CREATE OR REPLACE FUNCTION app_capture_artifact_manifest() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'embedding'-'updatedAt'-'parentCommunityId') IS NOT DISTINCT FROM (to_jsonb(OLD)-'embedding'-'updatedAt'-'parentCommunityId') THEN RETURN NEW; END IF;
 IF NULLIF(current_setting('app.artifact_inputs',true),'') IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NOT (app_is_service() AND current_setting('app.artifact_replacement',true)='verified') THEN
   IF NOT EXISTS(SELECT 1 FROM "ArtifactManifest" WHERE "artifactId"=NEW.id::text) THEN RETURN NEW; END IF;
 ELSE
   DELETE FROM "ArtifactDependency" WHERE "artifactId"=NEW.id::text;
   DELETE FROM "ArtifactManifest" WHERE "artifactId"=NEW.id::text;
 END IF;
 INSERT INTO "ArtifactDependency" (id,"artifactId","artifactKind","sourceDocumentId","sourceVersionId","sourceHash")
 SELECT gen_random_uuid(),NEW.id::text,TG_TABLE_NAME,p."documentId"::uuid,p."versionId"::uuid,p."sourceHash"
 FROM jsonb_to_recordset(current_setting('app.artifact_inputs')::jsonb) AS p("documentId" text,"versionId" text,"sourceHash" text)
 JOIN "Document" d ON d.id=p."documentId"::uuid AND d."kbId"=NEW."kbId"
 WHERE NOT EXISTS(SELECT 1 FROM "ArtifactDependency" a WHERE a."artifactId"=NEW.id::text
   AND a."sourceDocumentId"=p."documentId"::uuid AND a."sourceVersionId" IS NOT DISTINCT FROM p."versionId"::uuid AND a."sourceHash" IS NOT DISTINCT FROM p."sourceHash");
 INSERT INTO "ArtifactManifest" ("artifactId","artifactKind","expectedCount")
 SELECT NEW.id::text,TG_TABLE_NAME,count(*)::int FROM "ArtifactDependency" WHERE "artifactId"=NEW.id::text HAVING count(*)>0
 ON CONFLICT("artifactId") DO UPDATE SET "expectedCount"=EXCLUDED."expectedCount";
 RETURN NEW;
END $$;
