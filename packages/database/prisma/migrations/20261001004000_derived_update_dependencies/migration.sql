-- A merged entity can gain a new restricted source before the coalesced
-- rebuild. Preserve its old inputs AND add every new actual worker input.
-- Keeping only old dependencies would expose new text to old readers.
CREATE OR REPLACE FUNCTION app_capture_artifact_manifest() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NULLIF(current_setting('app.artifact_inputs',true),'') IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    -- An update cannot prove the inputs of an unknown legacy description.
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
