\set ON_ERROR_STOP on
\timing on
BEGIN;
DO $$ BEGIN
 IF current_database() NOT LIKE 'gbrain_core_opt_test%' THEN RAISE EXCEPTION 'Only isolated test databases are allowed'; END IF;
END $$;
CREATE ROLE artifact_guard_test_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO artifact_guard_test_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO artifact_guard_test_reader;
INSERT INTO "User"(id,username,"displayName",email) VALUES
 ('10000000-0000-4000-8000-000000000001','artifact-owner','Owner','artifact-owner@invalid.test'),
 ('10000000-0000-4000-8000-000000000002','artifact-reader','Reader','artifact-reader@invalid.test');
INSERT INTO "KnowledgeBase"(id,type,name,"ownerUserId","gitRepoUrl","updatedAt") VALUES
 ('10000000-0000-4000-8000-000000000020','industry','artifact guard','10000000-0000-4000-8000-000000000001','test://artifact',now()),
 ('10000000-0000-4000-8000-000000000021','personal','invisible','10000000-0000-4000-8000-000000000001','test://invisible',now());
INSERT INTO "IndustryGrant"(id,"kbId","subjectType","subjectId","grantedById") VALUES
 ('10000000-0000-4000-8000-000000000022','10000000-0000-4000-8000-000000000020','user','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001');
SELECT set_config('app.artifact_inputs','',true),set_config('app.service','on',true);
INSERT INTO "Document"(id,"kbId","mdPath",title,"sourceType",status,"updatedAt","contentHash")
 SELECT md5('artifact-doc-'||i)::uuid,'10000000-0000-4000-8000-000000000020',i||'.md',i::text,'upload','published',now(),'hash'
 FROM generate_series(1,908) i;
INSERT INTO "RaptorNode"(id,"kbId",title,content)
 SELECT md5('artifact-node-'||i)::uuid,'10000000-0000-4000-8000-000000000020',i::text,'summary'
 FROM generate_series(1,2232) i;
INSERT INTO "ArtifactDependency"(id,"artifactId","artifactKind","sourceDocumentId","sourceHash")
 SELECT gen_random_uuid(),r.id::text,'RaptorNode',d.id,'hash:1'
 FROM "RaptorNode" r CROSS JOIN "Document" d
 WHERE r."kbId"='10000000-0000-4000-8000-000000000020' AND d."kbId"=r."kbId";
INSERT INTO "ArtifactManifest"("artifactId","artifactKind","expectedCount")
 SELECT id::text,'RaptorNode',908 FROM "RaptorNode" WHERE "kbId"='10000000-0000-4000-8000-000000000020';
ANALYZE "ArtifactDependency";
ANALYZE "ArtifactManifest";
ANALYZE "Document";
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000002',true),set_config('app.service','off',true);
-- Original predicate remains available as an independent semantic oracle.
CREATE PROCEDURE pg_temp.assert_guard(expected integer) LANGUAGE plpgsql AS $$
DECLARE actual integer; BEGIN
 IF EXISTS (
   SELECT r.id FROM "RaptorNode" r
   LEFT JOIN app_readable_artifacts() a ON a."artifactId"=r.id::text AND a."kbId"=r."kbId"
   WHERE r."kbId"='10000000-0000-4000-8000-000000000020'
     AND r.id IN (SELECT md5('artifact-node-'||i)::uuid FROM generate_series(1,12) i)
     AND app_artifact_readable(r.id::text,r."kbId") IS DISTINCT FROM (a."artifactId" IS NOT NULL)
 ) THEN RAISE EXCEPTION 'Set guard differs from original guard'; END IF;
 EXECUTE 'SET LOCAL ROLE artifact_guard_test_reader';
 SELECT count(*) INTO actual FROM "RaptorNode" WHERE "kbId"='10000000-0000-4000-8000-000000000020';
 IF actual<>expected THEN RAISE EXCEPTION 'Expected %, got %',expected,actual; END IF;
 EXECUTE 'RESET ROLE';
END $$;
\if :{?skip_original}
\else
-- Full old-path timing, same source conjunction, same role-independent snapshot.
SELECT count(*) AS original_readable FROM "RaptorNode" r
 WHERE r."kbId"='10000000-0000-4000-8000-000000000020' AND app_artifact_readable(r.id::text,r."kbId");
\endif
SET LOCAL ROLE artifact_guard_test_reader;
EXPLAIN (ANALYZE,BUFFERS) SELECT count(*) FROM "RaptorNode" WHERE "kbId"='10000000-0000-4000-8000-000000000020';
RESET ROLE;
CALL pg_temp.assert_guard(2232);
-- Current ACL is enforced even though the KB remains visible.
UPDATE "Document" SET "aclMode"='restricted' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET "aclMode"='inherit' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(2232);
-- Hash, version, publication and temporal drift remain read-time guards.
SELECT set_config('app.service','on',true);
INSERT INTO "DocumentVersion"(id,"documentId",number,state,"sourceHash","parserFingerprint","chunkerFingerprint","manifestHash","mdPath",title,"publicationData") VALUES
 ('10000000-0000-4000-8000-000000000050',md5('artifact-doc-1')::uuid,1,'published','hash','test','test','test','1.md','1','{}');
UPDATE "Document" SET "activeVersionId"='10000000-0000-4000-8000-000000000050' WHERE id=md5('artifact-doc-1')::uuid;
SELECT set_config('app.service','off',true);
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET "activeVersionId"=NULL WHERE id=md5('artifact-doc-1')::uuid;
UPDATE "Document" SET "contentHash"='changed' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET "contentHash"='hash',version=2 WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET version=1,status='archived' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET status='published',"effectiveFrom"=statement_timestamp()+interval '1 hour' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
SELECT set_config('app.as_of',(statement_timestamp()+interval '2 hours')::text,true);
CALL pg_temp.assert_guard(2232);
SELECT set_config('app.as_of','',true);
UPDATE "Document" SET "effectiveFrom"=NULL,"effectiveTo"=statement_timestamp()-interval '1 hour' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET "effectiveTo"=NULL,"lifecycleStatus"='repealed' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET "lifecycleStatus"='active' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(2232);
-- Cross-KB dependencies, missing sources and incomplete manifests fail closed.
UPDATE "Document" SET "kbId"='10000000-0000-4000-8000-000000000021' WHERE id=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
UPDATE "Document" SET "kbId"='10000000-0000-4000-8000-000000000020' WHERE id=md5('artifact-doc-1')::uuid;
DELETE FROM "ArtifactDependency" WHERE "artifactId"=md5('artifact-node-1')::uuid::text AND "sourceDocumentId"=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(2231);
DELETE FROM "ArtifactManifest" WHERE "artifactId"=md5('artifact-node-2')::uuid::text;
CALL pg_temp.assert_guard(2230);
UPDATE "ArtifactDependency" SET "sourceDocumentId"='10000000-0000-4000-8000-000000000099' WHERE "sourceDocumentId"=md5('artifact-doc-1')::uuid;
CALL pg_temp.assert_guard(0);
SELECT set_config('app.user_id','',true);
CALL pg_temp.assert_guard(0);
SELECT set_config('app.service','on',true);
SET LOCAL ROLE artifact_guard_test_reader;
DO $$ BEGIN
 IF (SELECT count(*) FROM "RaptorNode" WHERE "kbId"='10000000-0000-4000-8000-000000000020')<>2232 THEN RAISE EXCEPTION 'Service behavior changed'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'artifact guard equivalence and scale passed' AS result;
