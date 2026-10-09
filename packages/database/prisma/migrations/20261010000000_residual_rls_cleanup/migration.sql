-- 20261010000000_residual_rls_cleanup
--
-- 20261007000000_remove_row_level_security 只覆盖当时已存在的表。之后新增的表
-- （如 ImportBatch、GraphEntityAlias）以及 gbrain 引擎 bootstrap 重新开启的 RLS，
-- 在 NOBYPASSRLS 运行时角色下会因"无策略即拒绝"导致 42501（压缩包入库 500）。
--
-- 本迁移幂等地：
--   1. 禁用所有普通表的 RLS（含 FORCE）并删除残留策略（权限语义仅在应用层）；
--   2. 对运行时角色 llmwiki_app（若存在）补齐表/序列授权及默认权限。

BEGIN;

DO $$
DECLARE
  r record;
  disabled integer := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (c.relrowsecurity OR c.relforcerowsecurity)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', r.schema, r.table);
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schema, r.table);
    disabled := disabled + 1;
  END LOOP;
  RAISE NOTICE 'RLS disabled on % residual table(s)', disabled;
END $$;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'llmwiki_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO llmwiki_app');
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO llmwiki_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO llmwiki_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO llmwiki_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO llmwiki_app';
  END IF;
END $$;

COMMIT;
