-- Additive migration. Existing roles are mapped once; display names no longer authorize.
ALTER TABLE "Role" ADD COLUMN "code" text;
CREATE UNIQUE INDEX "Role_code_key" ON "Role"("code");
UPDATE "Role" SET "code" = CASE name WHEN '系统管理员' THEN 'system_admin' WHEN '超级管理员' THEN 'super_admin' END
WHERE name IN ('系统管理员', '超级管理员');
ALTER TABLE "Document" ADD COLUMN "aclMode" text NOT NULL DEFAULT 'inherit';
ALTER TABLE "Document" ADD CONSTRAINT document_acl_mode_valid CHECK ("aclMode" IN ('inherit','restricted'));
UPDATE "Document" d SET "aclMode" = 'restricted' WHERE EXISTS (SELECT 1 FROM "DocumentAcl" a WHERE a."documentId" = d.id);
CREATE TABLE "AuthorizationState" (
  id integer PRIMARY KEY CHECK (id = 1), revision bigint NOT NULL DEFAULT 0,
  "policyVersion" text NOT NULL DEFAULT 'core-auth-v1', "updatedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO "AuthorizationState" (id) VALUES (1);
CREATE FUNCTION app_system_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public."UserRole" ur JOIN public."Role" r ON r.id=ur."roleId"
    JOIN public."User" u ON u.id=ur."userId"
    WHERE ur."userId"=p_user AND u.status='active' AND r.code IN ('system_admin','super_admin'))
$$;
CREATE OR REPLACE FUNCTION app_kb_system_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT public.app_system_admin(p_user) $$;
CREATE FUNCTION app_auth_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public."AuthorizationState" SET revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=1;
  PERFORM set_config('app.cache.visible_kbs','',true);
  PERFORM set_config('app.cache.is_admin','',true);
  PERFORM set_config('app.cache.managed_kbs','',true);
  RETURN NULL;
END $$;
-- Statement triggers serialize revisions with the authoritative mutation,
-- including direct SQL and cascades. Revision rollback follows transaction rollback.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['User','Role','UserRole','UserOrg','OrgNode','OrgAdmin','KbAdmin','IndustryGrant','DocumentAcl','KnowledgeBase'] LOOP
    EXECUTE format('CREATE TRIGGER core_auth_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_auth_changed()',t);
  END LOOP;
END $$;
CREATE TRIGGER core_document_auth_revision AFTER UPDATE OF "aclMode", status ON "Document"
FOR EACH STATEMENT EXECUTE FUNCTION app_auth_changed();
CREATE FUNCTION app_restrict_document_acl() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public."Document" SET "aclMode"='restricted' WHERE id=NEW."documentId" AND "aclMode" <> 'restricted';
  RETURN NEW;
END $$;
CREATE TRIGGER core_document_acl_restrict BEFORE INSERT ON "DocumentAcl"
FOR EACH ROW EXECUTE FUNCTION app_restrict_document_acl();

CREATE OR REPLACE FUNCTION public.app_visible_kb_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  v_user uuid := app_current_user_id();
  v_cache text;
  v_ids uuid[];
  v_admin boolean := false;
BEGIN
  IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM "User" WHERE id=v_user AND status='active') THEN RETURN; END IF;

  -- 事务级缓存命中：格式 "<userId>:uuid,uuid,..."
  v_cache := current_setting('app.cache.visible_kbs', true);
  IF v_cache LIKE v_user::text || ':%' THEN
    v_cache := substr(v_cache, length(v_user::text) + 2);
    IF v_cache = '' THEN RETURN; END IF;
    RETURN QUERY SELECT unnest(string_to_array(v_cache, ',')::uuid[]);
    RETURN;
  END IF;

  SELECT COALESCE(bool_or(r.code IN ('system_admin', 'super_admin')), false)
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
