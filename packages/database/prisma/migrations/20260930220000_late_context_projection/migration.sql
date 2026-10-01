CREATE TABLE "LateContextVector" (
 "generationId" uuid NOT NULL REFERENCES "IndexGeneration"(id) ON DELETE CASCADE,
 "blockId" uuid NOT NULL REFERENCES "BlockArtifact"(id) ON DELETE CASCADE,
 "modelFingerprint" text NOT NULL,
 "windowHash" text NOT NULL,
 embedding vector(1024) NOT NULL,
 PRIMARY KEY ("generationId","blockId")
);
CREATE INDEX late_context_model ON "LateContextVector" ("modelFingerprint");
ALTER TABLE "LateContextVector" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LateContextVector" FORCE ROW LEVEL SECURITY;
CREATE POLICY late_context_read ON "LateContextVector" FOR SELECT USING (EXISTS(SELECT 1 FROM "BlockArtifact" b WHERE b.id="blockId"));
CREATE POLICY late_context_service ON "LateContextVector" FOR ALL USING(app_is_service()) WITH CHECK(app_is_service());
CREATE TRIGGER late_context_immutable BEFORE UPDATE ON "LateContextVector" FOR EACH ROW EXECUTE FUNCTION app_immutable_generation_vector();
