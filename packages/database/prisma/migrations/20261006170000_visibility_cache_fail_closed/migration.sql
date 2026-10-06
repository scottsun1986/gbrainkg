BEGIN;
-- Two defects the new release checks surface. Both are additive: no applied
-- migration is rewritten, and the authorization contract only gets stricter.

-- 1. app_document_readable() reads the transaction-level visible-KB cache and
--    seeds it through app_visible_kb_ids(). That seeding function returns early
--    for a user who is not active, and then writes no cache entry — so a cache
--    left behind by a different user in the same transaction is still applied
--    to the current caller, and a document with no DocumentAcl row is then
--    reported readable. Every request sets app.user_id once per transaction
--    today, which is why this was latent rather than live; the boundary still
--    has to fail closed. Re-assert the cache owner after seeding and deny when
--    it cannot be confirmed for the current user.
CREATE OR REPLACE FUNCTION public.app_document_readable(p_document_id uuid, p_kb_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  v_user uuid := app_current_user_id();
  v_allowed boolean;
  v_visible_cache text;
  v_admin_cache text;
  v_is_admin boolean;
  v_managed_cache text;
BEGIN
  IF app_is_service() THEN RETURN true; END IF;
  IF v_user IS NULL THEN RETURN false; END IF;

  -- 可见 KB 判定：直接对事务级缓存做子串包含比较；缓存未建时先触发一次
  -- app_visible_kb_ids() 完成计算与缓存写入。
  v_visible_cache := current_setting('app.cache.visible_kbs', true);
  IF v_visible_cache IS NULL OR v_visible_cache NOT LIKE v_user::text || ':%' THEN
    PERFORM EXISTS(SELECT 1 FROM app_visible_kb_ids() k LIMIT 1);
    v_visible_cache := current_setting('app.cache.visible_kbs', true);
  END IF;
  -- 缓存必须确属当前用户。app_visible_kb_ids() 对未激活用户提前返回且不写缓存，
  -- 此时 v_visible_cache 仍可能保留同一事务内上一个用户的值；据此判可见即
  -- fail-open。无法确认归属时一律拒绝。
  IF v_visible_cache IS NULL OR v_visible_cache NOT LIKE v_user::text || ':%' THEN
    RETURN false;
  END IF;
  IF position(',' || p_kb_id::text || ',' in ',' || substr(v_visible_cache, length(v_user::text) + 2) || ',') = 0 THEN
    RETURN false;
  END IF;

  -- 系统管理员判定：事务级缓存（格式 "<userId>:t|f"），避免逐行重查 UserRole。
  v_admin_cache := current_setting('app.cache.is_admin', true);
  IF v_admin_cache IS NOT NULL AND split_part(v_admin_cache, ':', 1) = v_user::text THEN
    v_is_admin := split_part(v_admin_cache, ':', 2) = 't';
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
      WHERE ur."userId" = v_user
        AND (r.code IN ('system_admin', 'super_admin'))
    ) INTO v_is_admin;
    PERFORM set_config('app.cache.is_admin', v_user::text || ':' || (CASE WHEN v_is_admin THEN 't' ELSE 'f' END), true);
  END IF;
  -- Administrative configuration access does not grant restricted content access.

  -- KB owner/KbAdmin 判定：事务级缓存为 id 集合（格式 "<userId>:uuid,uuid,..."），
  -- 逐行退化为子串包含比较，替代每行两次索引探测。
  v_managed_cache := current_setting('app.cache.managed_kbs', true);
  IF v_managed_cache IS NULL OR split_part(v_managed_cache, ':', 1) <> v_user::text THEN
    SELECT v_user::text || ':' || COALESCE(array_to_string(ARRAY(
      SELECT k.id FROM "KnowledgeBase" k
      WHERE k."ownerUserId" = v_user
         OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = v_user)
    ), ','), '') INTO v_managed_cache;
    PERFORM set_config('app.cache.managed_kbs', v_managed_cache, true);
  END IF;
  IF position(',' || p_kb_id::text || ',' in ',' || substr(v_managed_cache, length(v_user::text) + 2) || ',') > 0 THEN
    RETURN true;
  END IF;

  IF EXISTS (SELECT 1 FROM "Document" d WHERE d.id = p_document_id AND d."aclMode" = 'inherit')
     AND NOT EXISTS (SELECT 1 FROM "DocumentAcl" a WHERE a."documentId" = p_document_id) THEN
    RETURN true;
  END IF;

  WITH subjects AS (
    SELECT 'user'::text AS subjectType, v_user::text AS subjectId
    UNION SELECT 'role', ur."roleId"::text FROM "UserRole" ur WHERE ur."userId" = v_user
    UNION SELECT 'org', uo."orgNodeId"::text FROM "UserOrg" uo WHERE uo."userId" = v_user
  )
  SELECT EXISTS (
    SELECT 1 FROM "DocumentAcl" a WHERE a."documentId" = p_document_id
      AND (a."subjectType", a."subjectId"::text) IN (SELECT subjectType, subjectId FROM subjects)
  ) INTO v_allowed;
  RETURN v_allowed;
END;
$function$;

-- 2. GraphCommunity carries kbId-scoped tenant data and already has six policies,
--    but RLS was only ENABLEd: the owning role still bypassed its policies. Match
--    the rest of the tenant tables.
ALTER TABLE "GraphCommunity" FORCE ROW LEVEL SECURITY;
COMMIT;
