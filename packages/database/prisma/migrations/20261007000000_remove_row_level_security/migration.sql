-- 20261007000000_remove_row_level_security
--
-- 运维决策：移除数据库行级安全(RLS)，权限语义全部下沉到应用层。
-- 本迁移禁用所有普通表的 RLS（含 FORCE）并删除现有全部行策略。
--
-- 安全提示：数据库不再提供任何租户隔离兜底，应用层必须独立完成鉴权与
-- 资源范围裁剪（参见 docs/RLS-BOUNDARIES.md 的应用层边界说明）。

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
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', r.schema, r.table);
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schema, r.table);
    disabled := disabled + 1;
  END LOOP;
  RAISE NOTICE 'RLS disabled on % table(s)', disabled;
END $$;

DO $$
DECLARE
  p record;
  dropped integer := 0;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    dropped := dropped + 1;
  END LOOP;
  RAISE NOTICE 'dropped % RLS policy(ies)', dropped;
END $$;

COMMIT;
