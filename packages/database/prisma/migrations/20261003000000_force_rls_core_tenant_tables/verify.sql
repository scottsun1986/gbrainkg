-- Smoke verification for 20261003000000_force_rls_core_tenant_tables.
-- Run after `prisma migrate deploy`:
--   psql "$DATABASE_URL" -f packages/database/prisma/migrations/20261003000000_force_rls_core_tenant_tables/verify.sql
-- Expected: all checks print PASS; exits non-zero on the first FAIL.
--
-- The check reflects the migration's own contract: every table that has both RLS
-- enabled and at least one policy in public must also be forced. Reporting the
-- offenders rather than only the count makes a regression actionable.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  t text;
  offenders text[] := ARRAY[]::text[];
  enabled boolean;
  forced boolean;
  pol_count int;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    ORDER BY c.relname
  LOOP
    SELECT c.relforcerowsecurity INTO forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = t;

    SELECT count(*) INTO pol_count
    FROM pg_policies WHERE schemaname = 'public' AND tablename = t;

    IF pol_count > 0 AND forced IS NOT TRUE THEN
      offenders := offenders || t;
    END IF;
  END LOOP;

  IF array_length(offenders, 1) > 0 THEN
    RAISE EXCEPTION 'FAIL: RLS enabled with policies but not forced on: %', array_to_string(offenders, ', ');
  END IF;

  RAISE NOTICE 'PASS: every policy-bearing table with RLS enabled is also FORCE ROW LEVEL SECURITY';
END $$;

-- Named spot checks for the core tenant tables, so a table silently losing its
-- RLS flag is reported even when its policies were also dropped.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Document','Chunk','KnowledgeBase','GraphEntity','GraphRelation','RaptorNode',
    'DocumentAcl','DocumentVersionLink','Conversation','Message','Citation',
    'ConnectorSource','ConnectorRun'
  ] LOOP
    -- Scope the existence probe to public exactly like the RLS check below:
    -- without the namespace filter a same-named table in any other schema
    -- satisfied it, so a genuinely missing core table was reported SKIP and the
    -- check silently stopped applying.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'SKIP: table % not present in this database', t;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'FAIL: % must have RLS enabled AND forced', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: core tenant tables have RLS enabled and forced';
END $$;

ROLLBACK;
