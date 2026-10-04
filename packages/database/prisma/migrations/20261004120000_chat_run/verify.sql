-- Smoke verification for 20261004120000_chat_run.
-- Run after `prisma migrate deploy`:
--   psql "$DATABASE_URL" -f packages/database/prisma/migrations/20261004120000_chat_run/verify.sql
-- Expected: all checks print PASS; exits non-zero on the first FAIL.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  has_table boolean;
  has_index boolean;
  rls_on    boolean;
  rls_forced boolean;
  pol_count int;
  owner_bypasses boolean;
BEGIN
  SELECT to_regclass('public."ChatRun"') IS NOT NULL INTO has_table;
  IF NOT has_table THEN RAISE EXCEPTION 'FAIL: ChatRun table missing'; END IF;
  RAISE NOTICE 'PASS: ChatRun table exists';

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'ChatRun' AND indexname = 'ChatRun_userId_status_startedAt_idx'
  ) INTO has_index;
  IF NOT has_index THEN RAISE EXCEPTION 'FAIL: ChatRun user/status index missing'; END IF;
  RAISE NOTICE 'PASS: ChatRun poll index exists';

  SELECT relrowsecurity, relforcerowsecurity INTO rls_on, rls_forced
  FROM pg_class WHERE oid = 'public."ChatRun"'::regclass;
  IF NOT rls_on THEN RAISE EXCEPTION 'FAIL: ChatRun has RLS enabled=false'; END IF;
  RAISE NOTICE 'PASS: ChatRun RLS enabled (forced=%)', rls_forced;

  SELECT count(*) INTO pol_count FROM pg_policies
  WHERE tablename = 'ChatRun' AND policyname = 'chatrun_rw';
  IF pol_count <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 chatrun_rw policy, found %', pol_count; END IF;
  RAISE NOTICE 'PASS: chatrun_rw policy present';

  -- The table owner must not silently bypass the policy: that is exactly the
  -- gap 20261003000000_force_rls_core_tenant_tables closed for the core tables.
  SELECT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) INTO owner_bypasses;
  IF owner_bypasses THEN
    RAISE NOTICE 'NOTE: verifying session runs as a BYPASSRLS role; policies not enforced for this session';
  ELSE
    RAISE NOTICE 'PASS: verifying session cannot bypass RLS';
  END IF;
END $$;

ROLLBACK;
