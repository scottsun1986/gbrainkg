BEGIN;
-- Additive repair: never rewrite applied migration history. Merge duplicate
-- authorizations using their effective union before enforcing identity keys.
ALTER TABLE "User" ADD COLUMN "mfaLastCounter" integer;
LOCK TABLE "IndustryGrant", "DocumentAcl" IN SHARE ROW EXCLUSIVE MODE;
WITH groups AS (
 SELECT "kbId","subjectType","subjectId",(array_agg(id ORDER BY "createdAt",id))[1] AS keep,
 CASE WHEN bool_or("expiresAt" IS NULL) THEN NULL ELSE max("expiresAt") END AS expiry
 FROM "IndustryGrant" GROUP BY "kbId","subjectType","subjectId" HAVING count(*)>1
) UPDATE "IndustryGrant" g SET "expiresAt"=groups.expiry FROM groups WHERE g.id=groups.keep;
DELETE FROM "IndustryGrant" g USING "IndustryGrant" keep
 WHERE (g."kbId",g."subjectType",g."subjectId")=(keep."kbId",keep."subjectType",keep."subjectId")
 AND (g."createdAt",g.id)>(keep."createdAt",keep.id);
-- The only supported DocumentAcl permission is read. Fail rather than discard
-- an unexpected legacy permission with potentially different semantics.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM "DocumentAcl" WHERE permission<>'read') THEN
 RAISE EXCEPTION 'Unsupported legacy DocumentAcl permission; inspect before deduplicating'; END IF; END $$;
DELETE FROM "DocumentAcl" a USING "DocumentAcl" keep
 WHERE (a."documentId",a."subjectType",a."subjectId")=(keep."documentId",keep."subjectType",keep."subjectId")
 AND (a."createdAt",a.id)>(keep."createdAt",keep.id);
DROP INDEX IF EXISTS "IndustryGrant_kbId_subjectType_subjectId_idx";
CREATE UNIQUE INDEX "IndustryGrant_kbId_subjectType_subjectId_key" ON "IndustryGrant"("kbId","subjectType","subjectId");
CREATE UNIQUE INDEX "DocumentAcl_documentId_subjectType_subjectId_key" ON "DocumentAcl"("documentId","subjectType","subjectId");
CREATE INDEX IF NOT EXISTS "Citation_chunkId_idx" ON "Citation"("chunkId");
CREATE INDEX IF NOT EXISTS "Citation_documentId_idx" ON "Citation"("documentId");
CREATE INDEX IF NOT EXISTS "Citation_kbId_idx" ON "Citation"("kbId");
ALTER TABLE "ChatRun" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuthorizationState" FORCE ROW LEVEL SECURITY;
-- Admission is a narrow SECURITY DEFINER operation; scope service access to
-- its quota mutation only and restore the caller context before returning.
CREATE OR REPLACE FUNCTION app_admit_model_call(resource_key text, request_limit int, token_limit bigint, input_tokens int) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE bucket bigint:=floor(extract(epoch FROM clock_timestamp())/60); admitted boolean;
 previous_service text:=current_setting('app.service',true);
BEGIN
 IF NOT app_is_service() AND NOT EXISTS(SELECT 1 FROM "User" WHERE id=app_current_user_id() AND status='active') THEN RETURN false; END IF;
 IF request_limit<1 OR token_limit<1 OR input_tokens<0 OR input_tokens>token_limit THEN RETURN false; END IF;
 PERFORM set_config('app.service','on',true);
 BEGIN
  INSERT INTO "ModelQuotaBucket" (key,period,requests,tokens) VALUES(resource_key,bucket,1,input_tokens)
  ON CONFLICT(key,period) DO UPDATE SET requests="ModelQuotaBucket".requests+1,tokens="ModelQuotaBucket".tokens+input_tokens
  WHERE "ModelQuotaBucket".requests<request_limit AND "ModelQuotaBucket".tokens+input_tokens<=token_limit RETURNING true INTO admitted;
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.service',COALESCE(previous_service,'off'),true);
  RAISE;
 END;
 PERFORM set_config('app.service',COALESCE(previous_service,'off'),true);
 RETURN COALESCE(admitted,false);
END $$;
ALTER TABLE "ModelQuotaBucket" FORCE ROW LEVEL SECURITY;

-- Shared identities remain application mediated. Secret credentials have an
-- owner boundary plus a narrow pre-authentication hash-matched read boundary.
ALTER TABLE "UserCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserCredential" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_credential_read ON "UserCredential" FOR SELECT USING (
 app_is_service() OR "userId"=app_current_user_id()
 OR (status='active' AND "appId"=current_setting('app.auth_app_id',true)
     AND "appSecretHash"=current_setting('app.auth_secret_hash',true))
);
CREATE POLICY user_credential_write ON "UserCredential" FOR ALL
 USING(app_is_service() OR "userId"=app_current_user_id())
 WITH CHECK(app_is_service() OR "userId"=app_current_user_id());
ALTER TABLE "ModelProvider" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModelProvider" FORCE ROW LEVEL SECURITY;
-- app_kb_has_permission() is revoked from PUBLIC and granted only to the
-- deployment runtime role by 20260927100000 — and only for the two
-- app_kb_can_* wrappers. A policy expression is evaluated as the caller, so
-- referencing the helper directly here made every ModelProvider access fail
-- with 42501 (permission denied for function app_kb_has_permission) for the
-- NOBYPASSRLS runtime role. Go through a granted, argument-free SECURITY
-- DEFINER wrapper instead; it also avoids exposing a "does user X hold
-- permission Y" oracle to the runtime role.
CREATE FUNCTION app_current_user_has_permission(p_permission text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app_kb_has_permission(app_current_user_id(),p_permission)
$$;
REVOKE ALL ON FUNCTION app_current_user_has_permission(text) FROM PUBLIC;
-- Same database-name to runtime-role convention 20260927100000 uses. Unlike
-- that migration this grant is skipped (not failed) for an unrecognised
-- database name, so an ad-hoc test database can still run the chain.
DO $$
DECLARE runtime_role text; candidate_roles text[];
BEGIN
 candidate_roles := CASE
  WHEN current_database() = 'llmwiki' THEN ARRAY['llmwiki_app','llmwiki_app_inst1']
  WHEN current_database() ~ '^llmwiki_inst[0-9]+$'
   THEN ARRAY[replace(current_database(),'llmwiki_inst','llmwiki_app_inst')]
  ELSE NULL END;
 IF candidate_roles IS NULL THEN RETURN; END IF;
 FOREACH runtime_role IN ARRAY candidate_roles LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_user_has_permission(text) TO %I',runtime_role);
  END IF;
 END LOOP;
END $$;
-- Providers are global inference configuration, not user-owned records.
-- Authorized requests need the configured keys to call their selected models.
CREATE POLICY model_provider_read ON "ModelProvider" FOR SELECT USING(
 app_is_service() OR EXISTS(SELECT 1 FROM "User" WHERE id=app_current_user_id() AND status='active'));
CREATE POLICY model_provider_write ON "ModelProvider" FOR ALL
 USING(app_is_service() OR app_current_user_has_permission('system.settings.manage'))
 WITH CHECK(app_is_service() OR app_current_user_has_permission('system.settings.manage'));
ALTER TABLE "FeedbackCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeedbackCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_case_rw ON "FeedbackCase" FOR ALL
 USING(app_is_service() OR "userId"=app_current_user_id() OR app_system_admin(app_current_user_id()))
 WITH CHECK(app_is_service() OR "userId"=app_current_user_id() OR app_system_admin(app_current_user_id()));
CREATE FUNCTION app_source_key_readable(source_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app_is_service() OR EXISTS(SELECT 1 FROM public."KnowledgeBase" kb WHERE kb.id IN(SELECT app_visible_kb_ids())
  AND source_key='llmwiki-kb-' || substr(encode(sha256(convert_to(kb.id::text,'UTF8')),'hex'),1,16))
$$;
CREATE FUNCTION app_source_keys_readable(source_keys jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE key text;
BEGIN
 IF app_is_service() THEN RETURN true; END IF;
 IF jsonb_typeof(source_keys) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 FOR key IN SELECT jsonb_array_elements_text(source_keys) LOOP
  IF NOT app_source_key_readable(key) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE "BrainScopeMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainScopeMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_member_read ON "BrainScopeMember" FOR SELECT USING(app_is_service() OR "userId"=app_current_user_id());
CREATE POLICY scope_member_write ON "BrainScopeMember" FOR ALL
 USING(app_is_service() OR "userId"=app_current_user_id())
 WITH CHECK(app_is_service() OR ("userId"=app_current_user_id() AND EXISTS(
  SELECT 1 FROM "BrainScope" s WHERE s.id="scopeId" AND app_source_keys_readable(s."sourceKeys"))));
ALTER TABLE "BrainSourceMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainSourceMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY source_member_read ON "BrainSourceMember" FOR SELECT USING(app_is_service() OR "userId"=app_current_user_id());
CREATE POLICY source_member_write ON "BrainSourceMember" FOR ALL
 USING(app_is_service() OR "userId"=app_current_user_id())
 WITH CHECK(app_is_service() OR ("userId"=app_current_user_id() AND EXISTS(
  SELECT 1 FROM "BrainSource" s WHERE s.id="sourceId" AND app_source_key_readable(s."sourceKey"))));
ALTER TABLE "BrainSourceDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainSourceDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY source_document_read ON "BrainSourceDocument" FOR SELECT USING(
 app_is_service() OR EXISTS(SELECT 1 FROM "Document" d WHERE d.id="documentId" AND d.status='published' AND app_document_readable(d.id,d."kbId")));
CREATE POLICY source_document_write ON "BrainSourceDocument" FOR ALL
 USING(app_is_service() OR EXISTS(SELECT 1 FROM "Document" d WHERE d.id="documentId" AND app_document_write(d."kbId")))
 WITH CHECK(app_is_service() OR EXISTS(SELECT 1 FROM "Document" d WHERE d.id="documentId" AND app_document_write(d."kbId")));

CREATE FUNCTION app_manifest_documents_readable(manifest jsonb, exact_version boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; identifier text; doc public."Document"%ROWTYPE;
 reference_time timestamptz:=COALESCE(NULLIF(current_setting('app.as_of',true),'')::timestamptz,statement_timestamp());
BEGIN
 IF app_is_service() THEN RETURN true; END IF;
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'array' OR jsonb_array_length(manifest)=0 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(manifest) LOOP
  identifier:=COALESCE(item->>'documentId',item->>'docId');
  IF identifier IS NULL OR identifier !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  SELECT * INTO doc FROM public."Document" WHERE id=identifier::uuid;
  IF NOT FOUND OR doc.status<>'published' OR NOT app_document_readable(doc.id,doc."kbId")
   OR (doc."effectiveFrom" IS NOT NULL AND doc."effectiveFrom">reference_time)
   OR (doc."effectiveTo" IS NOT NULL AND doc."effectiveTo"<=reference_time)
   OR (doc."lifecycleStatus"='repealed' AND doc."effectiveTo" IS NULL) THEN RETURN false; END IF;
  IF exact_version AND ((item->>'versionId') IS DISTINCT FROM doc."activeVersionId"::text
    OR (item->>'number') IS DISTINCT FROM doc.version::text
    OR (item->>'sourceHash') IS DISTINCT FROM doc."contentHash") THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app_manifest_documents_readable(jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_manifest_documents_readable(jsonb,boolean) TO PUBLIC;
ALTER TABLE "SemanticCache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SemanticCache" FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_cache_rw ON "SemanticCache" FOR ALL
 USING(app_is_service() OR app_manifest_documents_readable("dependencyManifest",true))
 WITH CHECK(app_is_service() OR app_manifest_documents_readable("dependencyManifest",true));
ALTER TABLE "BrainDerivedPage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainDerivedPage" FORCE ROW LEVEL SECURITY;
CREATE POLICY derived_page_read ON "BrainDerivedPage" FOR SELECT USING(
 app_is_service() OR (
  EXISTS(SELECT 1 FROM "BrainScopeMember" m JOIN "BrainScope" s ON s.id=m."scopeId"
   WHERE m."scopeId"="BrainDerivedPage"."scopeId" AND m."userId"=app_current_user_id()
   AND m."validFrom"<=statement_timestamp() AND (m."validTo" IS NULL OR m."validTo">statement_timestamp())
   AND s.status='active' AND s."aclEpoch"="BrainDerivedPage"."aclEpoch" AND s."knowledgeEpoch"="BrainDerivedPage"."knowledgeEpoch")
  AND app_manifest_documents_readable("derivedFrom",false)
  AND jsonb_typeof("sourceKeys")='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text("sourceKeys") k WHERE NOT EXISTS(
   SELECT 1 FROM "BrainSource" src JOIN "BrainSourceMember" m ON m."sourceId"=src.id
   WHERE src."sourceKey"=k AND m."userId"=app_current_user_id() AND src.status='active'))
 ));
CREATE POLICY derived_page_service ON "BrainDerivedPage" FOR ALL USING(app_is_service()) WITH CHECK(app_is_service());
CREATE POLICY derived_page_insert ON "BrainDerivedPage" FOR INSERT
 WITH CHECK(app_source_keys_readable("sourceKeys") AND app_manifest_documents_readable("derivedFrom",false)
  AND EXISTS(SELECT 1 FROM "BrainScopeMember" m WHERE m."scopeId"="BrainDerivedPage"."scopeId" AND m."userId"=app_current_user_id()));
CREATE POLICY derived_page_update ON "BrainDerivedPage" FOR UPDATE
 USING(EXISTS(SELECT 1 FROM "BrainScopeMember" m WHERE m."scopeId"="BrainDerivedPage"."scopeId" AND m."userId"=app_current_user_id()))
 WITH CHECK(app_source_keys_readable("sourceKeys") AND app_manifest_documents_readable("derivedFrom",false)
  AND EXISTS(SELECT 1 FROM "BrainScopeMember" m WHERE m."scopeId"="BrainDerivedPage"."scopeId" AND m."userId"=app_current_user_id()));

-- Rebuild a dirty/old-epoch page through a narrow authorized publication
-- function: stale content remains invisible even while its replacement writes.
CREATE FUNCTION app_publish_derived_page(p_scope uuid,p_slug text,p_title text,p_kind text,p_content text,
 p_derived jsonb,p_sources jsonb,p_fingerprint text,p_acl integer,p_knowledge integer,p_model text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope public."BrainScope"%ROWTYPE; previous_service text:=current_setting('app.service',true);
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(current_database() || ':core-auth-output',0));
 SELECT * INTO scope FROM "BrainScope" WHERE id=p_scope FOR UPDATE;
 IF NOT FOUND OR scope."aclEpoch"<>p_acl OR scope."knowledgeEpoch"<>p_knowledge OR scope."sourceKeys" IS DISTINCT FROM p_sources THEN
  RAISE EXCEPTION 'Derived publication inputs changed'; END IF;
 IF NOT app_is_service() AND (NOT app_source_keys_readable(p_sources) OR NOT app_manifest_documents_readable(p_derived,false)
  OR NOT EXISTS(SELECT 1 FROM "BrainScopeMember" WHERE "scopeId"=p_scope AND "userId"=app_current_user_id()
    AND "validFrom"<=statement_timestamp() AND ("validTo" IS NULL OR "validTo">statement_timestamp()))) THEN
  RAISE EXCEPTION 'Derived publication not authorized' USING ERRCODE='42501'; END IF;
 PERFORM set_config('app.service','on',true);
 BEGIN
  INSERT INTO "BrainDerivedPage" (id,"scopeId",slug,title,kind,content,"derivedFrom","sourceKeys","inputFingerprint","aclEpoch","knowledgeEpoch","modelVersion","updatedAt")
  VALUES(gen_random_uuid(),p_scope,p_slug,p_title,p_kind,p_content,p_derived,p_sources,p_fingerprint,p_acl,p_knowledge,p_model,now())
  ON CONFLICT("scopeId",slug) DO UPDATE SET title=EXCLUDED.title,kind=EXCLUDED.kind,content=EXCLUDED.content,
   "derivedFrom"=EXCLUDED."derivedFrom","sourceKeys"=EXCLUDED."sourceKeys","inputFingerprint"=EXCLUDED."inputFingerprint",
   "aclEpoch"=EXCLUDED."aclEpoch","knowledgeEpoch"=EXCLUDED."knowledgeEpoch","modelVersion"=EXCLUDED."modelVersion","updatedAt"=now();
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.service',COALESCE(previous_service,'off'),true); RAISE; END;
 PERFORM set_config('app.service',COALESCE(previous_service,'off'),true);
END $$;
REVOKE ALL ON FUNCTION app_publish_derived_page(uuid,text,text,text,text,jsonb,jsonb,text,integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_publish_derived_page(uuid,text,text,text,text,jsonb,jsonb,text,integer,integer,text) TO PUBLIC;

-- Only authority-bearing changes advance the global authority revision.
-- Content publication still shares the strict-output fence; exact source
-- version/hash dependencies determine whether a particular answer is stale.
CREATE FUNCTION app_authority_row_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE before_row jsonb; after_row jsonb; fields text[]; changed boolean;
BEGIN
 IF TG_OP='UPDATE' THEN
  before_row:=to_jsonb(OLD); after_row:=to_jsonb(NEW);
  fields:=CASE TG_TABLE_NAME
   WHEN 'User' THEN ARRAY['status','mustChangePassword','mfaEnabled','passwordHash']
   WHEN 'Role' THEN ARRAY['code','permissions']
   WHEN 'OrgNode' THEN ARRAY['parentId','path','status']
   WHEN 'KnowledgeBase' THEN ARRAY['type','ownerUserId','orgNodeId','status']
   WHEN 'Document' THEN ARRAY['aclMode','kbId','effectiveFrom','effectiveTo','lifecycleStatus']
   ELSE NULL END;
  IF fields IS NULL THEN changed:=before_row IS DISTINCT FROM after_row;
  ELSE SELECT EXISTS(SELECT 1 FROM unnest(fields) field WHERE (before_row->field) IS DISTINCT FROM (after_row->field)) INTO changed; END IF;
  IF TG_TABLE_NAME='Document' THEN changed:=changed OR (OLD.status='published' AND NEW.status<>'published'); END IF;
 ELSE
  changed:=TG_TABLE_NAME<>'Document' OR TG_OP='DELETE';
 END IF;
 IF changed THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(current_database() || ':core-auth-output',0));
  UPDATE "AuthorizationState" SET revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=1;
  PERFORM set_config('app.cache.visible_kbs','',true);
  PERFORM set_config('app.cache.is_admin','',true);
  PERFORM set_config('app.cache.managed_kbs','',true);
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION app_content_output_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(current_database() || ':core-auth-output',0));
 RETURN NULL;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['User','Role','UserRole','UserOrg','OrgNode','OrgAdmin','KbAdmin','IndustryGrant','DocumentAcl','KnowledgeBase'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS core_auth_revision ON %I',tab);
  EXECUTE format('CREATE TRIGGER core_auth_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_authority_row_changed()',tab);
 END LOOP;
END $$;
DROP TRIGGER core_document_auth_revision ON "Document";
DROP TRIGGER core_document_delete_revision ON "Document";
CREATE TRIGGER core_document_auth_revision AFTER UPDATE OR DELETE ON "Document" FOR EACH ROW EXECUTE FUNCTION app_authority_row_changed();
CREATE TRIGGER core_document_content_fence AFTER UPDATE OF status,"activeVersionId","contentHash","effectiveFrom","effectiveTo","lifecycleStatus" ON "Document" FOR EACH ROW EXECUTE FUNCTION app_content_output_fence();
DROP TRIGGER active_generation_auth_revision ON "ActiveIndexGeneration";
CREATE TRIGGER active_generation_output_fence AFTER INSERT OR UPDATE OR DELETE ON "ActiveIndexGeneration" FOR EACH ROW EXECUTE FUNCTION app_content_output_fence();

ALTER TABLE "BrainChangeEvent" ADD COLUMN "claimToken" text, ADD COLUMN "claimedAt" timestamp(3);
ALTER TABLE "ChatRun" ADD COLUMN "leaseExpiresAt" timestamp(3);
CREATE INDEX "ChatRun_status_leaseExpiresAt_startedAt_idx" ON "ChatRun"(status,"leaseExpiresAt","startedAt");
COMMIT;
