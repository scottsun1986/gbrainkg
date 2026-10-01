\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database()<>'llmwiki_inst99999' THEN RAISE EXCEPTION 'Only the dedicated local migration fixture is allowed';END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='llmwiki_app_inst99999' AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe runtime fixture';END IF;
 IF EXISTS(SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='llmwiki_app_inst99999' AND ('app.service=on'=ANY(s.setconfig) OR EXISTS(SELECT 1 FROM unnest(s.setconfig) value WHERE value LIKE 'app.user_id=%'))) THEN RAISE EXCEPTION 'Legacy role privilege default survived migration';END IF;
END $$;
INSERT INTO "User"(id,username,"displayName",email) VALUES('00000000-0000-4000-8000-000000000051','migration-reader','migration reader','migration@invalid.test');
SET LOCAL ROLE llmwiki_app_inst99999;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000051',true),set_config('app.service','off',true);
DO $$ DECLARE affected int;BEGIN
 IF NOT EXISTS(SELECT 1 FROM "AuthorizationState") THEN RAISE EXCEPTION 'Runtime cannot read authority state';END IF;
 UPDATE "AuthorizationState" SET revision=revision+1;GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'Runtime mutated authority state';END IF;
 IF NOT app_admit_model_call('runtime-test-quota',1,100,60) THEN RAISE EXCEPTION 'Runtime admission unavailable';END IF;
 IF app_admit_model_call('runtime-test-quota',1,100,60) THEN RAISE EXCEPTION 'Runtime exceeded quota';END IF;
 IF EXISTS(SELECT 1 FROM "ModelArtifactCache") OR EXISTS(SELECT 1 FROM "GraphProjectionInput") THEN RAISE EXCEPTION 'Service projection visible to user';END IF;
 PERFORM count(*) FROM "DocumentVersion";PERFORM count(*) FROM "BlockArtifact";PERFORM count(*) FROM "IndexGeneration";
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'fresh migrations and scoped NOBYPASSRLS runtime grants passed' AS result;
