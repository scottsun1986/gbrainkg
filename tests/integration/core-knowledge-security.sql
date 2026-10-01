\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'gbrain_core_opt_test%' THEN RAISE EXCEPTION 'Only isolated core optimization test databases are allowed'; END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gbrain_core_test_reader') THEN
    CREATE ROLE gbrain_core_test_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO gbrain_core_test_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO gbrain_core_test_reader;
INSERT INTO "User"(id,username,"displayName",email) VALUES
 ('00000000-0000-4000-8000-000000000001','owner','Owner','owner@core.test'),
 ('00000000-0000-4000-8000-000000000002','reader','Reader','reader@core.test'),
 ('00000000-0000-4000-8000-000000000003','wildcard','Wildcard','wildcard@core.test');
INSERT INTO "Role"(id,name,builtin,permissions) VALUES ('00000000-0000-4000-8000-000000000010','custom-wildcard',true,'["*"]');
INSERT INTO "UserRole" VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000010');
INSERT INTO "KnowledgeBase"(id,type,name,"ownerUserId","gitRepoUrl","updatedAt") VALUES
 ('00000000-0000-4000-8000-000000000020','industry','test industry','00000000-0000-4000-8000-000000000001','test://kb',now()),
 ('00000000-0000-4000-8000-000000000021','personal','private','00000000-0000-4000-8000-000000000001','test://private',now());
INSERT INTO "IndustryGrant"(id,"kbId","subjectType","subjectId","grantedById") VALUES
 ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000020','user','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
INSERT INTO "Document"(id,"kbId","mdPath",title,"sourceType",status,"updatedAt","contentHash") VALUES
 ('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000020','public.md','public','upload','published',now(),'hash-public'),
 ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000020','secret.md','secret','upload','published',now(),'hash-secret');
INSERT INTO "DocumentAcl"(id,"documentId","subjectType","subjectId") VALUES
 ('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000031','user','00000000-0000-4000-8000-000000000002');
SELECT set_config('app.artifact_inputs','[{"documentId":"00000000-0000-4000-8000-000000000030","versionId":null,"sourceHash":"hash-public:1"},{"documentId":"00000000-0000-4000-8000-000000000031","versionId":null,"sourceHash":"hash-secret:1"}]',true);
INSERT INTO "GraphEntity"(id,"kbId",name,"updatedAt") VALUES
 ('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000020','mixed-input-entity',now());
SET LOCAL ROLE gbrain_core_test_reader;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000002',true),set_config('app.service','off',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM "Document")<>2 THEN RAISE EXCEPTION 'grant cannot read expected documents'; END IF;
  IF (SELECT count(*) FROM "GraphEntity")<>1 THEN RAISE EXCEPTION 'complete readable graph inputs hidden'; END IF;
  IF EXISTS(SELECT 1 FROM "KnowledgeBase" WHERE type='personal') THEN RAISE EXCEPTION 'personal KB leaked'; END IF;
END $$;
DO $$ DECLARE affected int; BEGIN
  UPDATE "AuthorizationState" SET revision=revision+1000 WHERE id=1;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'reader changed authoritative revision'; END IF;
  IF NOT app_admit_model_call('core-test-shared-quota',1,100,60) THEN RAISE EXCEPTION 'active user admission failed'; END IF;
END $$;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
  IF app_admit_model_call('core-test-shared-quota',1,100,10) THEN RAISE EXCEPTION 'quota was per-user instead of instance-shared'; END IF;
END $$;
SELECT set_config('app.user_id','',true);
DO $$ BEGIN
  IF app_admit_model_call('anonymous-quota',10,100,1) THEN RAISE EXCEPTION 'anonymous model admission'; END IF;
END $$;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000002',true);
-- A reader must not be able to remove its own ACL via SQL.
DO $$ DECLARE affected int; BEGIN
  DELETE FROM "DocumentAcl" WHERE id='00000000-0000-4000-8000-000000000032'; GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'reader mutated ACL'; END IF;
END $$;
RESET ROLE;
DELETE FROM "DocumentAcl" WHERE id='00000000-0000-4000-8000-000000000032';
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN
  IF (SELECT count(*) FROM "Document")<>1 THEN RAISE EXCEPTION 'last ACL deletion restored inheritance'; END IF;
  IF EXISTS(SELECT 1 FROM "GraphEntity") THEN RAISE EXCEPTION 'mixed-source graph leaked after revocation'; END IF;
  IF app_system_admin('00000000-0000-4000-8000-000000000003') THEN RAISE EXCEPTION 'wildcard/builtin became system admin'; END IF;
END $$;
RESET ROLE;
UPDATE "Document" SET "aclMode"='inherit' WHERE id='00000000-0000-4000-8000-000000000031';
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN
  IF (SELECT count(*) FROM "Document")<>2 THEN RAISE EXCEPTION 'explicit inheritance did not restore access'; END IF;
END $$;
RESET ROLE;
UPDATE "User" SET status='disabled' WHERE id='00000000-0000-4000-8000-000000000002';
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM "Document") THEN RAISE EXCEPTION 'disabled user can read'; END IF; END $$;
RESET ROLE;
UPDATE "User" SET status='active' WHERE id='00000000-0000-4000-8000-000000000002';
INSERT INTO "Document"(id,"kbId","mdPath",title,"sourceType",status,"updatedAt","contentHash","aclMode") VALUES
 ('00000000-0000-4000-8000-000000000033','00000000-0000-4000-8000-000000000020','new-secret.md','new secret','upload','published',now(),'new-secret','restricted');
SELECT set_config('app.artifact_inputs','[{"documentId":"00000000-0000-4000-8000-000000000030","versionId":null,"sourceHash":"hash-public:1"}]',true);
INSERT INTO "GraphEntity"(id,"kbId",name,"updatedAt") VALUES
 ('00000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-000000000020','growing-inputs',now());
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "GraphEntity" WHERE name='growing-inputs') THEN RAISE EXCEPTION 'authorized initial entity hidden'; END IF;
END $$;
RESET ROLE;
SELECT set_config('app.artifact_inputs','[{"documentId":"00000000-0000-4000-8000-000000000030","versionId":null,"sourceHash":"hash-public:1"},{"documentId":"00000000-0000-4000-8000-000000000033","versionId":null,"sourceHash":"new-secret:1"}]',true);
UPDATE "GraphEntity" SET description='new restricted contribution' WHERE id='00000000-0000-4000-8000-000000000041';
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "GraphEntity" WHERE name='growing-inputs') THEN RAISE EXCEPTION 'new merged source was absent from dependencies'; END IF;
END $$;
RESET ROLE;
UPDATE "Document" SET "effectiveFrom"=now()+interval '1 hour' WHERE id='00000000-0000-4000-8000-000000000030';
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "GraphEntity" WHERE name='mixed-input-entity') THEN RAISE EXCEPTION 'future-effective graph entered current scope'; END IF;
END $$;
SELECT set_config('app.as_of',(now()+interval '2 hours')::text,true);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "GraphEntity" WHERE name='mixed-input-entity') THEN RAISE EXCEPTION 'explicit temporal graph scope ignored'; END IF;
END $$;
RESET ROLE;
-- Legacy original snapshots keep block IDs and enforce the same current ACL.
SELECT set_config('app.service','on',true);
INSERT INTO "DocumentVersion"(id,"documentId",number,state,"sourceHash","parserFingerprint","chunkerFingerprint","manifestHash","mdPath",title,"publicationData") VALUES
 ('00000000-0000-4000-8000-000000000050','00000000-0000-4000-8000-000000000030',1,'published','hash-public','legacy','legacy','legacy','public.md','public','{}'),
 ('00000000-0000-4000-8000-000000000051','00000000-0000-4000-8000-000000000031',1,'published','hash-secret','legacy','legacy','legacy','secret.md','secret','{}');
INSERT INTO "BlockArtifact"(id,"versionId",ord,content,"tokenCount","charStart","charEnd","rawHash","indexTextHash") VALUES
 ('00000000-0000-4000-8000-000000000060','00000000-0000-4000-8000-000000000050',0,'enriched public',2,0,6,'old-index-hash','index'),
 ('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000051',0,'enriched secret',2,0,6,'old-index-hash','index');
INSERT INTO "OriginalBlockSnapshot"("blockId","versionId","charStart","charEnd","rawContent","rawHash","parsedHash","sourcePath") VALUES
 ('00000000-0000-4000-8000-000000000060','00000000-0000-4000-8000-000000000050',0,6,'public',encode(digest('public','sha256'),'hex'),'source-hash','original-public.md'),
 ('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000051',0,6,'secret',encode(digest('secret','sha256'),'hex'),'source-hash','original-secret.md');
DO $$ BEGIN
 BEGIN
  UPDATE "OriginalBlockSnapshot" SET "rawContent"='changed' WHERE "blockId"='00000000-0000-4000-8000-000000000060';
  RAISE EXCEPTION 'Snapshot mutation was accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'Original snapshot is immutable' THEN RAISE; END IF;
 END;
 IF EXISTS(SELECT 1 FROM "BlockArtifact" WHERE "rawContent" IS NOT NULL) THEN RAISE EXCEPTION 'Backfill changed immutable published blocks'; END IF;
END $$;
SELECT set_config('app.service','off',true);
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN IF (SELECT count(*) FROM "OriginalBlockSnapshot")<>2 THEN RAISE EXCEPTION 'Readable originals hidden'; END IF; END $$;
RESET ROLE;
UPDATE "Document" SET "aclMode"='restricted' WHERE id='00000000-0000-4000-8000-000000000031';
SET LOCAL ROLE gbrain_core_test_reader;
DO $$ BEGIN IF (SELECT count(*) FROM "OriginalBlockSnapshot")<>1 THEN RAISE EXCEPTION 'Original snapshot ignored current document ACL'; END IF; END $$;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000003',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM "OriginalBlockSnapshot") THEN RAISE EXCEPTION 'Original source leaked across authorization scopes'; END IF; END $$;
RESET ROLE;
ROLLBACK;
SELECT 'core knowledge RLS matrix passed' AS result;
