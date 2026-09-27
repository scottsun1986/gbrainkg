-- Correct the inst1 runtime-role mapping after 20260927100000. Its database is
-- named llmwiki, while existing production may connect as llmwiki_app_inst1.
-- This compensating migration also keeps fresh/legacy llmwiki_app installs
-- working and remains scoped to the current instance's NOBYPASSRLS role(s).
DO $$
DECLARE
  candidate_roles text[];
  runtime_role text;
  granted integer := 0;
BEGIN
  candidate_roles := CASE
    WHEN current_database() = 'llmwiki' THEN ARRAY['llmwiki_app', 'llmwiki_app_inst1']
    WHEN current_database() ~ '^llmwiki_inst[0-9]+$'
      THEN ARRAY[replace(current_database(), 'llmwiki_inst', 'llmwiki_app_inst')]
    ELSE NULL
  END;
  IF candidate_roles IS NULL THEN
    RAISE EXCEPTION 'Unknown runtime role mapping for database %', current_database();
  END IF;
  FOR runtime_role IN
    SELECT rolname FROM pg_roles WHERE rolname = ANY(candidate_roles)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role AND (rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'Runtime role % must be NOBYPASSRLS', runtime_role;
    END IF;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app_kb_can_manage(uuid, text, uuid, uuid), app_kb_can_create(text, uuid, uuid, text) TO %I',
      runtime_role
    );
    granted := granted + 1;
  END LOOP;
  IF granted = 0 THEN
    RAISE EXCEPTION 'Expected runtime role is missing for database %', current_database();
  END IF;
END $$;
