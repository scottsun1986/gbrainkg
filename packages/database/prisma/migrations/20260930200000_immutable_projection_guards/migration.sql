DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['Chunk','GraphEntity','GraphRelation','GraphCommunity','RaptorNode'] LOOP
    EXECUTE format('CREATE POLICY core_projection_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (app_is_service())',table_name);
    EXECUTE format('CREATE POLICY core_projection_update ON %I AS RESTRICTIVE FOR UPDATE USING (app_is_service()) WITH CHECK (app_is_service())',table_name);
    EXECUTE format('CREATE POLICY core_projection_delete ON %I AS RESTRICTIVE FOR DELETE USING (app_is_service())',table_name);
  END LOOP;
END $$;
CREATE FUNCTION app_immutable_version_input() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF (to_jsonb(NEW)-'state'-'publishedAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'publishedAt') THEN
    RAISE EXCEPTION 'DocumentVersion input is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_version_input BEFORE UPDATE ON "DocumentVersion" FOR EACH ROW EXECUTE FUNCTION app_immutable_version_input();
CREATE FUNCTION app_immutable_block_input() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF (to_jsonb(NEW)-'embedding'-'embedding_fingerprint') IS DISTINCT FROM (to_jsonb(OLD)-'embedding'-'embedding_fingerprint') THEN
    RAISE EXCEPTION 'BlockArtifact input is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_block_input BEFORE UPDATE ON "BlockArtifact" FOR EACH ROW EXECUTE FUNCTION app_immutable_block_input();
CREATE FUNCTION app_document_version_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  IF NEW."activeVersionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "DocumentVersion" v WHERE v.id=NEW."activeVersionId" AND v."documentId"=NEW.id AND v.state='published') THEN
    RAISE EXCEPTION 'Active version must belong to the published document';
  END IF;
  IF NEW."buildingVersionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "DocumentVersion" v WHERE v.id=NEW."buildingVersionId" AND v."documentId"=NEW.id AND v.number=NEW."ingestVersion") THEN
    RAISE EXCEPTION 'Building version must match the pending input';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_binding BEFORE INSERT OR UPDATE OF "activeVersionId","buildingVersionId" ON "Document"
FOR EACH ROW EXECUTE FUNCTION app_document_version_binding();
