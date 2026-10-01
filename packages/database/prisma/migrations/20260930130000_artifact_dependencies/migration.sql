-- Historical derived artifacts have unknown input completeness and stay hidden
-- until rebuilt. New artifacts capture a conservative complete KB manifest.
CREATE TABLE "ArtifactManifest" (
  "artifactId" text PRIMARY KEY,
  "artifactKind" text NOT NULL,
  "expectedCount" integer NOT NULL CHECK ("expectedCount" > 0),
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION app_capture_artifact_manifest() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Updates of unknown legacy descriptions cannot prove their actual inputs.
  IF TG_OP='UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NULLIF(current_setting('app.artifact_inputs',true),'') IS NULL THEN RETURN NEW; END IF;
  DELETE FROM "ArtifactDependency" WHERE "artifactId"=NEW.id::text;
  DELETE FROM "ArtifactManifest" WHERE "artifactId"=NEW.id::text;
  INSERT INTO "ArtifactDependency" (id,"artifactId","artifactKind","sourceDocumentId","sourceVersionId","sourceHash")
  SELECT gen_random_uuid(), NEW.id::text, TG_TABLE_NAME, p."documentId"::uuid,p."versionId"::uuid,p."sourceHash"
  FROM jsonb_to_recordset(current_setting('app.artifact_inputs')::jsonb) AS p("documentId" text,"versionId" text,"sourceHash" text)
  JOIN "Document" d ON d.id=p."documentId"::uuid WHERE d."kbId"=NEW."kbId";
  INSERT INTO "ArtifactManifest" ("artifactId","artifactKind","expectedCount")
  SELECT NEW.id::text,TG_TABLE_NAME,count(*)::int FROM "ArtifactDependency" WHERE "artifactId"=NEW.id::text HAVING count(*)>0;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app_artifact_readable(p_id text, p_kb uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT app_current_user_id() IS NOT NULL
    AND p_kb IN(SELECT app_visible_kb_ids())
    AND EXISTS(SELECT 1 FROM "ArtifactManifest" m WHERE m."artifactId"=p_id
      AND m."expectedCount"=(SELECT count(*) FROM "ArtifactDependency" a WHERE a."artifactId"=p_id))
    AND NOT EXISTS(SELECT 1 FROM "ArtifactDependency" a LEFT JOIN "Document" d ON d.id=a."sourceDocumentId"
      WHERE a."artifactId"=p_id AND (d.id IS NULL OR d.status<>'published' OR d."kbId"<>p_kb
        OR d."activeVersionId" IS DISTINCT FROM a."sourceVersionId"
        OR COALESCE(d."contentHash",'') || ':' || d.version::text <> a."sourceHash"
        OR NOT app_document_readable(d.id,d."kbId")));
$$;

-- RESTRICTIVE policies intersect the existing KB policies instead of being
-- OR-combined with them. Service mutations retain their current scoped path.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['GraphEntity','GraphRelation','GraphCommunity','RaptorNode'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY artifact_inputs_guard ON %I AS RESTRICTIVE FOR SELECT USING (app_is_service() OR app_artifact_readable(id::text,"kbId"))',table_name);
    EXECUTE format('CREATE POLICY artifact_service_access ON %I FOR ALL USING (app_is_service()) WITH CHECK (app_is_service())',table_name);
    EXECUTE format('CREATE TRIGGER capture_artifact_manifest AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_capture_artifact_manifest()',table_name);
  END LOOP;
END $$;
CREATE POLICY community_reader ON "GraphCommunity" FOR SELECT
  USING (app_is_service() OR "kbId" IN (SELECT app_visible_kb_ids()));

ALTER TABLE "ArtifactManifest" ENABLE ROW LEVEL SECURITY;
CREATE POLICY artifact_manifest_service ON "ArtifactManifest" FOR ALL USING (app_is_service()) WITH CHECK (app_is_service());
CREATE POLICY artifact_manifest_reader ON "ArtifactManifest" FOR SELECT USING (
  app_is_service() OR EXISTS (SELECT 1 FROM "ArtifactDependency" a WHERE a."artifactId"="ArtifactManifest"."artifactId"
    AND app_document_readable(a."sourceDocumentId",(SELECT "kbId" FROM "Document" WHERE id=a."sourceDocumentId")))
);
CREATE INDEX block_embedding_text_reuse ON "BlockArtifact" (embedding_fingerprint,md5(content)) WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION app_role_code_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF OLD.code IS NOT NULL AND OLD.code IS DISTINCT FROM NEW.code THEN RAISE EXCEPTION 'Role code is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_code_immutable BEFORE UPDATE OF code ON "Role" FOR EACH ROW EXECUTE FUNCTION app_role_code_immutable();
