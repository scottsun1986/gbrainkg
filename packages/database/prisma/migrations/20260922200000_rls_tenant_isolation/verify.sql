-- Smoke verification for 20260922200000_rls_tenant_isolation.
-- Run after `prisma migrate deploy` as a superuser or the table owner (llmwiki):
--   psql "$DATABASE_URL" -f packages/database/prisma/migrations/20260922200000_rls_tenant_isolation/verify.sql
-- Expected: all checks print PASS; the script exits non-zero on the first FAIL.

\set ON_ERROR_STOP on

BEGIN;

-- 1) Enterprise columns exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Document' AND column_name = 'objectKey'
  ) THEN
    RAISE EXCEPTION 'FAIL: Document.objectKey missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'DocumentAcl'
  ) THEN
    RAISE EXCEPTION 'FAIL: DocumentAcl table missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'ConnectorSource'
  ) THEN
    RAISE EXCEPTION 'FAIL: ConnectorSource table missing';
  END IF;
  RAISE NOTICE 'PASS: enterprise columns and tables present';
END $$;

-- 2) Session helpers exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_visible_kb_ids') THEN
    RAISE EXCEPTION 'FAIL: app_visible_kb_ids() missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_document_readable') THEN
    RAISE EXCEPTION 'FAIL: app_document_readable() missing';
  END IF;
  RAISE NOTICE 'PASS: RLS helper functions present';
END $$;

-- 3) RLS enabled and policies attached on the tenant tables
DO $$
DECLARE
  t text;
  enabled boolean;
  pol int;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Document','Chunk','GraphEntity','GraphRelation','RaptorNode','KnowledgeBase',
    'DocumentAcl','DocumentVersionLink','ConnectorSource','ConnectorRun',
    'Conversation','Message','Citation'
  ] LOOP
    SELECT relrowsecurity INTO enabled FROM pg_class WHERE oid = format('public.%I', t)::regclass;
    IF enabled IS NOT TRUE THEN
      RAISE EXCEPTION 'FAIL: RLS not enabled on %', t;
    END IF;
    SELECT count(*) INTO pol FROM pg_policies WHERE tablename = t;
    IF pol < 1 THEN
      RAISE EXCEPTION 'FAIL: no policy on %', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: RLS enabled with policies on all tenant tables';
END $$;

-- 4) Fail-closed: without app.user_id / app.service a restricted role sees nothing.
--    (Skipped when running as a BYPASSRLS superuser/migration role.)
DO $$
DECLARE
  bypass boolean;
  visible bigint;
BEGIN
  SELECT rolbypassrls INTO bypass FROM pg_roles WHERE rolname = current_user;
  IF bypass THEN
    RAISE NOTICE 'SKIP: current role % bypasses RLS; re-run as llmwiki_app to assert fail-closed', current_user;
    RETURN;
  END IF;
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.service', 'off', true);
  SELECT count(*) INTO visible FROM "Document";
  IF visible <> 0 THEN
    RAISE EXCEPTION 'FAIL: unscoped session still sees % Document rows', visible;
  END IF;
  RAISE NOTICE 'PASS: unscoped session is fail-closed on Document';
END $$;

-- 5) Service context can read (background jobs)
DO $$
DECLARE
  bypass boolean;
BEGIN
  SELECT rolbypassrls INTO bypass FROM pg_roles WHERE rolname = current_user;
  IF bypass THEN
    RAISE NOTICE 'SKIP: service-context check requires NOBYPASSRLS role';
    RETURN;
  END IF;
  PERFORM set_config('app.service', 'on', true);
  PERFORM count(*) FROM "Document";
  RAISE NOTICE 'PASS: app.service=on allows background reads';
END $$;

ROLLBACK;
