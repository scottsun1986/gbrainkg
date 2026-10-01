CREATE TABLE "GenerationVector" (
  "generationId" uuid NOT NULL REFERENCES "IndexGeneration"(id) ON DELETE CASCADE,
  "blockId" uuid NOT NULL REFERENCES "BlockArtifact"(id) ON DELETE CASCADE,
  embedding vector(1024) NOT NULL,
  PRIMARY KEY ("generationId","blockId")
);
CREATE TABLE "ActiveIndexGeneration" (
  "versionId" uuid PRIMARY KEY REFERENCES "DocumentVersion"(id) ON DELETE CASCADE,
  "generationId" uuid NOT NULL REFERENCES "IndexGeneration"(id) ON DELETE CASCADE
);
ALTER TABLE "GenerationVector" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GenerationVector" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ActiveIndexGeneration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActiveIndexGeneration" FORCE ROW LEVEL SECURITY;
CREATE POLICY generation_vector_read ON "GenerationVector" FOR SELECT USING (EXISTS(SELECT 1 FROM "IndexGeneration" g WHERE g.id="generationId"));
CREATE POLICY generation_vector_service ON "GenerationVector" FOR ALL USING (app_is_service()) WITH CHECK(app_is_service());
CREATE POLICY active_generation_read ON "ActiveIndexGeneration" FOR SELECT USING (EXISTS(SELECT 1 FROM "DocumentVersion" v WHERE v.id="versionId"));
CREATE POLICY active_generation_service ON "ActiveIndexGeneration" FOR ALL USING (app_is_service()) WITH CHECK(app_is_service());
CREATE FUNCTION app_immutable_generation_vector() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Generation vectors are immutable'; END $$;
CREATE TRIGGER immutable_generation_vector BEFORE UPDATE ON "GenerationVector" FOR EACH ROW EXECUTE FUNCTION app_immutable_generation_vector();
CREATE FUNCTION app_active_generation_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "IndexGeneration" g WHERE g.id=NEW."generationId" AND g."versionId"=NEW."versionId" AND g.channel='dense' AND g.state='ready' AND g."expectedCount"=g."readyCount") THEN
  RAISE EXCEPTION 'Active dense generation must be complete and bound to version';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER active_generation_binding BEFORE INSERT OR UPDATE ON "ActiveIndexGeneration" FOR EACH ROW EXECUTE FUNCTION app_active_generation_binding();
CREATE TRIGGER active_generation_auth_revision AFTER INSERT OR UPDATE OR DELETE ON "ActiveIndexGeneration" FOR EACH STATEMENT EXECUTE FUNCTION app_auth_changed();
INSERT INTO "GenerationVector" SELECT g.id,b.id,b.embedding FROM "IndexGeneration" g JOIN "BlockArtifact" b ON b."versionId"=g."versionId" AND b.embedding_fingerprint=g."modelFingerprint" WHERE g.channel='dense' AND g.state='ready' AND b.embedding IS NOT NULL;
INSERT INTO "ActiveIndexGeneration" SELECT g."versionId",g.id FROM "IndexGeneration" g JOIN "Document" d ON d."activeVersionId"=g."versionId" WHERE g.channel='dense' AND g.state='ready' AND (SELECT count(*) FROM "GenerationVector" v WHERE v."generationId"=g.id)=g."expectedCount" ON CONFLICT DO NOTHING;
