-- RLS 可见性热路径：事务级缓存。
--
-- 背景：Chunk/Document/DocumentAcl 等 RLS 策略对结果集每一行调用
-- app_document_readable()，其内部又会调用 app_visible_kb_ids()（含递归
-- 组织树、IndustryGrant 授权扫描）以及 UserRole 管理员判定。在万级 Chunk
-- 的 count/scan 上被逐行放大：同一 count(*) 无 RLS 约 16ms，RLS 下约 2000ms，
-- 管理台遥测/清单请求因此累积到 5~50 秒。
--
-- 修复：在事务内首次计算后写入 tx-local GUC（set_config ... , true，
-- 事务提交/回滚自动清除），同一事务内的后续逐行调用退化为内存比较。
-- 缓存键携带 user_id，用户上下文变化不会读到陈旧值。语义与原实现一致，
-- 仅消除重复计算；对语料与业务场景保持通用（Corpus-Agnostic）。

CREATE OR REPLACE FUNCTION public.app_visible_kb_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := app_current_user_id();
  v_cache text;
  v_ids uuid[];
  v_admin boolean := false;
BEGIN
  IF v_user IS NULL THEN RETURN; END IF;

  -- 事务级缓存命中：格式 "<userId>:uuid,uuid,..."
  v_cache := current_setting('app.cache.visible_kbs', true);
  IF v_cache LIKE v_user::text || ':%' THEN
    v_cache := substr(v_cache, length(v_user::text) + 2);
    IF v_cache = '' THEN RETURN; END IF;
    RETURN QUERY SELECT unnest(string_to_array(v_cache, ',')::uuid[]);
    RETURN;
  END IF;

  SELECT COALESCE(bool_or(r.name IN ('系统管理员', '超级管理员') OR r.permissions::text LIKE '%"*"%'), false)
    INTO v_admin
  FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
  WHERE ur."userId" = v_user;

  IF v_admin THEN
    v_ids := array(
      SELECT DISTINCT k.id FROM "KnowledgeBase" k
      WHERE k.status = 'active'
        AND (k.type IN ('org', 'industry') OR k."ownerUserId" = v_user
          OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = v_user)
          OR (k.type = 'personal' AND k."ownerUserId" = v_user))
    );
  ELSE
    v_ids := array(
      SELECT k.id FROM "KnowledgeBase" k
      WHERE k.type = 'personal' AND k."ownerUserId" = v_user AND k.status = 'active'
    );
    v_ids := v_ids || array(
      SELECT k.id FROM "KnowledgeBase" k
      WHERE k.type <> 'personal' AND k.status = 'active'
        AND (k."ownerUserId" = v_user
          OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = v_user))
    );
    v_ids := v_ids || array(
      WITH RECURSIVE org_up AS (
        SELECT o."orgNodeId" AS id FROM "UserOrg" o WHERE o."userId" = v_user
        UNION
        SELECT n."parentId" FROM "OrgNode" n JOIN org_up u ON n.id = u.id
        WHERE n."parentId" IS NOT NULL AND n.status = 'active'
      )
      SELECT k.id FROM "KnowledgeBase" k
      WHERE k.type = 'org' AND k.status = 'active' AND k."orgNodeId" IN (SELECT id FROM org_up)
    );
    v_ids := v_ids || array(
      WITH RECURSIVE org_up AS (
        SELECT o."orgNodeId" AS id FROM "UserOrg" o WHERE o."userId" = v_user
        UNION
        SELECT n."parentId" FROM "OrgNode" n JOIN org_up u ON n.id = u.id
        WHERE n."parentId" IS NOT NULL AND n.status = 'active'
      ), subjects AS (
        SELECT 'user'::text AS subjectType, v_user::text AS subjectId
        UNION SELECT 'role', ur."roleId"::text FROM "UserRole" ur WHERE ur."userId" = v_user
        UNION SELECT 'org', id::text FROM org_up
      )
      SELECT g."kbId" FROM "IndustryGrant" g
      JOIN "KnowledgeBase" k ON k.id = g."kbId" AND k.type = 'industry' AND k.status = 'active'
      WHERE (g."subjectType", g."subjectId"::text) IN (SELECT subjectType, subjectId FROM subjects)
        AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
    );
  END IF;

  PERFORM set_config('app.cache.visible_kbs', v_user::text || ':' || array_to_string(v_ids, ','), true);
  IF array_length(v_ids, 1) IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT unnest(v_ids);
END;
$function$;

CREATE OR REPLACE FUNCTION public.app_document_readable(p_document_id uuid, p_kb_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
        AND (r.name IN ('系统管理员', '超级管理员') OR r.permissions::text LIKE '%"*"%')
    ) INTO v_is_admin;
    PERFORM set_config('app.cache.is_admin', v_user::text || ':' || (CASE WHEN v_is_admin THEN 't' ELSE 'f' END), true);
  END IF;
  IF v_is_admin THEN RETURN true; END IF;

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

  IF NOT EXISTS (SELECT 1 FROM "DocumentAcl" a WHERE a."documentId" = p_document_id) THEN
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
