-- Run only against an isolated fully migrated database as a migration role.
-- Everything, including the temporary runtime role, rolls back.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE security_repair_test_runtime NOLOGIN NOBYPASSRLS NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO security_repair_test_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO security_repair_test_runtime;
INSERT INTO "User" (id,username,"displayName",email,status,source) VALUES
 ('b0060000-0000-4000-8000-000000000001','security-test-a','A','security-test-a@example.invalid','active','manual'),
 ('b0060000-0000-4000-8000-000000000002','security-test-b','B','security-test-b@example.invalid','active','manual');
INSERT INTO "UserCredential" (id,"userId","appId","appSecretHash","appSecretEnc",status,"updatedAt") VALUES
 ('b0060000-0000-4000-8000-000000000003','b0060000-0000-4000-8000-000000000001','fixture-app-a','fixture-secret-hash-a','fixture-secret-a','active',now()),
 ('b0060000-0000-4000-8000-000000000004','b0060000-0000-4000-8000-000000000002','fixture-app-b','fixture-secret-hash-b','fixture-secret-b','active',now());
INSERT INTO "KnowledgeBase" (id,type,name,"gitRepoUrl","ownerUserId",status,"updatedAt") VALUES
 ('b0060000-0000-4000-8000-000000000005','personal','Fixture','db://fixture','b0060000-0000-4000-8000-000000000001','active',now());
INSERT INTO "Document" (id,"kbId","mdPath",title,"sourceType",status,"updatedAt") VALUES
 ('b0060000-0000-4000-8000-000000000006','b0060000-0000-4000-8000-000000000005','fixture.md','Fixture','manual','parsing',now());
DO $$ DECLARE initial bigint; BEGIN
 SELECT revision INTO initial FROM "AuthorizationState" WHERE id=1;
 UPDATE "User" SET "displayName"='renamed' WHERE id='b0060000-0000-4000-8000-000000000001';
 UPDATE "Document" SET status='parsing',"contentHash"='new-content' WHERE id='b0060000-0000-4000-8000-000000000006';
 IF (SELECT revision FROM "AuthorizationState" WHERE id=1)<>initial THEN RAISE EXCEPTION 'Pure content or display metadata advanced global authority'; END IF;
 UPDATE "Document" SET "aclMode"='restricted' WHERE id='b0060000-0000-4000-8000-000000000006';
 IF (SELECT revision FROM "AuthorizationState" WHERE id=1)<=initial THEN RAISE EXCEPTION 'ACL change did not advance authority'; END IF;
 SELECT revision INTO initial FROM "AuthorizationState" WHERE id=1;
 UPDATE "User" SET status='disabled' WHERE id='b0060000-0000-4000-8000-000000000002';
 IF (SELECT revision FROM "AuthorizationState" WHERE id=1)<=initial THEN RAISE EXCEPTION 'User disable did not advance authority'; END IF;
END $$;
-- A private published document anchors cache and derived source permissions.
INSERT INTO "Document" (id,"kbId","mdPath",title,"sourceType",status,"updatedAt") VALUES
 ('b0060000-0000-4000-8000-000000000007','b0060000-0000-4000-8000-000000000005','evidence.md','Evidence','manual','published',now());
INSERT INTO "BrainSource" (id,"sourceKey",kind,"scopeKey") VALUES
 ('b0060000-0000-4000-8000-000000000008','llmwiki-kb-' || substr(encode(sha256(convert_to('b0060000-0000-4000-8000-000000000005','UTF8')),'hex'),1,16),'private','fixture');
INSERT INTO "BrainSourceMember" ("sourceId","userId") VALUES
 ('b0060000-0000-4000-8000-000000000008','b0060000-0000-4000-8000-000000000001');
INSERT INTO "BrainSourceDocument" ("sourceId","documentId") VALUES
 ('b0060000-0000-4000-8000-000000000008','b0060000-0000-4000-8000-000000000007');
INSERT INTO "BrainScope" (id,fingerprint,"sourceKeys","updatedAt","knowledgeEpoch") VALUES
 ('b0060000-0000-4000-8000-000000000009','fixture-scope',jsonb_build_array('llmwiki-kb-' || substr(encode(sha256(convert_to('b0060000-0000-4000-8000-000000000005','UTF8')),'hex'),1,16)),now(),2);
INSERT INTO "BrainScopeMember" ("scopeId","userId") VALUES
 ('b0060000-0000-4000-8000-000000000009','b0060000-0000-4000-8000-000000000001');
INSERT INTO "BrainDerivedPage" (id,"scopeId",slug,title,kind,content,"derivedFrom","sourceKeys","inputFingerprint","aclEpoch","knowledgeEpoch","updatedAt")
 SELECT 'b0060000-0000-4000-8000-000000000010',id,'derived/scope-summary','Old','summary','private-stale',
 '[{"docId":"b0060000-0000-4000-8000-000000000007"}]'::jsonb,"sourceKeys",'old',1,1,now() FROM "BrainScope" WHERE fingerprint='fixture-scope';
INSERT INTO "SemanticCache" (id,"queryText","scopeFingerprint","responseContent","dependencyManifest") VALUES
 ('security-fixture-cache','private-question','fixture','private-answer','[{"documentId":"b0060000-0000-4000-8000-000000000007","versionId":null,"number":1,"sourceHash":null}]');
SET LOCAL ROLE security_repair_test_runtime;
SELECT set_config('app.service','off',true),set_config('app.user_id','',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "UserCredential") THEN RAISE EXCEPTION 'Unauthenticated secret disclosure'; END IF;
 IF EXISTS(SELECT 1 FROM "SemanticCache") THEN RAISE EXCEPTION 'Unauthenticated semantic cache disclosure'; END IF;
END $$;
SELECT set_config('app.auth_app_id','fixture-app-a',true),set_config('app.auth_secret_hash','wrong-secret',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM "UserCredential") THEN RAISE EXCEPTION 'Wrong credential hash exposed secret'; END IF; END $$;
SELECT set_config('app.auth_secret_hash','fixture-secret-hash-a',true);
DO $$ BEGIN IF (SELECT count(*) FROM "UserCredential")<>1 THEN RAISE EXCEPTION 'Hash-authenticated credential lookup failed'; END IF; END $$;
SELECT set_config('app.auth_app_id','',true),set_config('app.auth_secret_hash','',true),set_config('app.user_id','b0060000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM "UserCredential")<>1 THEN RAISE EXCEPTION 'Owner secret boundary failed'; END IF;
 IF (SELECT count(*) FROM "SemanticCache" WHERE id='security-fixture-cache')<>1 THEN RAISE EXCEPTION 'Valid owner semantic cache was denied'; END IF;
 IF EXISTS(SELECT 1 FROM "BrainDerivedPage" WHERE id='b0060000-0000-4000-8000-000000000010') THEN RAISE EXCEPTION 'Stale derived epoch was exposed'; END IF;
 PERFORM app_publish_derived_page('b0060000-0000-4000-8000-000000000009','derived/scope-summary','Rebuilt','summary','private-fresh',
  '[{"docId":"b0060000-0000-4000-8000-000000000007"}]'::jsonb,
  (SELECT "sourceKeys" FROM "BrainScope" WHERE fingerprint='fixture-scope'),'fresh',1,2,'test-model');
 IF (SELECT content FROM "BrainDerivedPage" WHERE id='b0060000-0000-4000-8000-000000000010') IS DISTINCT FROM 'private-fresh' THEN RAISE EXCEPTION 'Dirty derived rebuild failed'; END IF;
 IF NOT app_admit_model_call('repair-test-quota',1,100,5) THEN RAISE EXCEPTION 'FORCE RLS broke authenticated quota admission'; END IF;
 IF app_admit_model_call('repair-test-quota',1,100,5) THEN RAISE EXCEPTION 'Quota duplicate admission exceeded limit'; END IF;
 IF app_is_service() THEN RAISE EXCEPTION 'Quota admission leaked service context'; END IF;
 IF EXISTS(SELECT 1 FROM "ModelQuotaBucket") THEN RAISE EXCEPTION 'Quota mutation widened direct runtime reads'; END IF;
END $$;
SELECT set_config('app.user_id','b0060000-0000-4000-8000-000000000002',true);
DO $$ DECLARE denied boolean:=false; BEGIN
 IF EXISTS(SELECT 1 FROM "SemanticCache" WHERE id='security-fixture-cache') THEN RAISE EXCEPTION 'Private cache exposed to outsider'; END IF;
 IF EXISTS(SELECT 1 FROM "BrainDerivedPage" WHERE id='b0060000-0000-4000-8000-000000000010') THEN RAISE EXCEPTION 'Private derived page exposed to outsider'; END IF;
 IF EXISTS(SELECT 1 FROM "BrainSourceDocument" WHERE "documentId"='b0060000-0000-4000-8000-000000000007') THEN RAISE EXCEPTION 'Private source mapping exposed to outsider'; END IF;
 BEGIN INSERT INTO "BrainSourceMember" ("sourceId","userId") VALUES ('b0060000-0000-4000-8000-000000000008','b0060000-0000-4000-8000-000000000002');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Outsider forged source membership'; END IF;
END $$;
RESET ROLE;
DO $$ DECLARE missing text[]; BEGIN
 SELECT array_agg(c.relname) INTO missing FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(ARRAY['UserCredential','ModelProvider','SemanticCache','BrainDerivedPage','BrainScopeMember','BrainSourceMember','BrainSourceDocument','FeedbackCase','ChatRun','AuthorizationState','ModelQuotaBucket'])
 AND NOT(c.relrowsecurity AND c.relforcerowsecurity);
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Missing forced RLS: %',missing; END IF;
END $$;
ROLLBACK;
