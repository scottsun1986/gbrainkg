-- Only the runtime role(s) of this database receive new projection privileges.
-- HTTP identities remain constrained by the restrictive RLS policies.
DO $$ DECLARE candidates text[];runtime text;relation text;BEGIN
 candidates:=CASE WHEN current_database()='llmwiki' THEN ARRAY['llmwiki_app','llmwiki_app_inst1']
  WHEN current_database()~'^llmwiki_inst[0-9]+$' THEN ARRAY[replace(current_database(),'llmwiki_inst','llmwiki_app_inst')]
  ELSE ARRAY[]::text[] END;
 FOR runtime IN SELECT rolname FROM pg_roles WHERE rolname=ANY(candidates) LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe runtime role %',runtime;END IF;
  EXECUTE format('ALTER ROLE %I RESET "app.service"',runtime);
  EXECUTE format('ALTER ROLE %I RESET "app.user_id"',runtime);
  EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET "app.service"',runtime,current_database());
  EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET "app.user_id"',runtime,current_database());
  FOREACH relation IN ARRAY ARRAY['AuthorizationState','DocumentVersion','BlockArtifact','IndexGeneration','ArtifactDependency','ArtifactManifest','GenerationVector','ActiveIndexGeneration','LateContextVector','ModelArtifactCache','ModelQuotaBucket','GraphProjectionInput'] LOOP
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO %I',relation,runtime);
  END LOOP;
 END LOOP;
END $$;
