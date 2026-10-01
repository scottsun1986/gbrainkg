CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE "OriginalBlockSnapshot" (
 "blockId" uuid PRIMARY KEY REFERENCES "BlockArtifact"(id) ON DELETE CASCADE,
 "versionId" uuid NOT NULL, "charStart" integer NOT NULL, "charEnd" integer NOT NULL,
 "rawContent" text NOT NULL, "rawHash" text NOT NULL, "parsedHash" text NOT NULL,
 "sourcePath" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 CHECK ("charStart">=0 AND "charEnd">"charStart")
);
CREATE INDEX original_block_snapshot_version ON "OriginalBlockSnapshot"("versionId");
CREATE FUNCTION app_original_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Original snapshot is immutable'; END IF;
 IF NOT app_is_service() OR NOT EXISTS (
  SELECT 1 FROM public."BlockArtifact" b JOIN public."DocumentVersion" v ON v.id=b."versionId"
  WHERE b.id=NEW."blockId" AND b."versionId"=NEW."versionId" AND b."rawContent" IS NULL
   AND b."charStart"=NEW."charStart" AND b."charEnd"=NEW."charEnd" AND v.state='published'
 ) OR encode(public.digest(NEW."rawContent",'sha256'),'hex')<>NEW."rawHash" THEN
  RAISE EXCEPTION 'Unverified original snapshot';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER original_snapshot_guard BEFORE INSERT OR UPDATE ON "OriginalBlockSnapshot" FOR EACH ROW EXECUTE FUNCTION app_original_snapshot_guard();
ALTER TABLE "OriginalBlockSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OriginalBlockSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY original_snapshot_read ON "OriginalBlockSnapshot" FOR SELECT USING
 (app_is_service() OR EXISTS(SELECT 1 FROM "BlockArtifact" b WHERE b.id="OriginalBlockSnapshot"."blockId" AND b."versionId"="OriginalBlockSnapshot"."versionId"));
CREATE POLICY original_snapshot_write ON "OriginalBlockSnapshot" FOR ALL USING (app_is_service()) WITH CHECK (app_is_service());
