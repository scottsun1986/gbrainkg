-- Isolated test database only. Always rolls fixture writes back; SQL errors abort.
\set ON_ERROR_STOP on
BEGIN;
\ir ../packages/database/prisma/migrations/20260927100000_kb_write_rls_guard/security-test.sql
ROLLBACK;
