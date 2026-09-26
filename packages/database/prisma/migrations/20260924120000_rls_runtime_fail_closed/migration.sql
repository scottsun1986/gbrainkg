-- The runtime-role bootstrap clears the legacy app.service default. Prisma
-- migrations run under a BYPASSRLS role that need not have CREATEROLE, so
-- role changes deliberately live outside this migration.

-- The original deployed function compared IndustryGrant.subjectId (uuid) to
-- text subjects. It was never exercised while app.service defaulted to on.
-- Recreate it with an explicit cast before activating user-scoped queries.
CREATE OR REPLACE FUNCTION app_visible_kb_ids() RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS
$$
DECLARE
  v_user uuid := app_current_user_id();
  v_admin boolean := false;
BEGIN
  IF v_user IS NULL THEN RETURN; END IF;

  SELECT COALESCE(bool_or(r.name IN ('系统管理员', '超级管理员') OR r.permissions::text LIKE '%"*"%'), false)
    INTO v_admin
  FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
  WHERE ur."userId" = v_user;

  IF v_admin THEN
    RETURN QUERY SELECT DISTINCT k.id FROM "KnowledgeBase" k
    WHERE k.status = 'active'
      AND (k.type IN ('org', 'industry') OR k."ownerUserId" = v_user
        OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = v_user)
        OR (k.type = 'personal' AND k."ownerUserId" = v_user));
    RETURN;
  END IF;

  RETURN QUERY SELECT k.id FROM "KnowledgeBase" k
    WHERE k.type = 'personal' AND k."ownerUserId" = v_user AND k.status = 'active';

  RETURN QUERY SELECT k.id FROM "KnowledgeBase" k
    WHERE k.type <> 'personal' AND k.status = 'active'
      AND (k."ownerUserId" = v_user
        OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = v_user));

  RETURN QUERY
    WITH RECURSIVE org_up AS (
      SELECT o."orgNodeId" AS id FROM "UserOrg" o WHERE o."userId" = v_user
      UNION
      SELECT n."parentId" FROM "OrgNode" n JOIN org_up u ON n.id = u.id
      WHERE n."parentId" IS NOT NULL AND n.status = 'active'
    )
    SELECT k.id FROM "KnowledgeBase" k
    WHERE k.type = 'org' AND k.status = 'active' AND k."orgNodeId" IN (SELECT id FROM org_up);

  RETURN QUERY
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
      AND (g."expiresAt" IS NULL OR g."expiresAt" > now());
END;
$$;

-- KB owners must retain access to restricted documents, matching the API ACL
-- service. The prior function only exempted explicit KbAdmin rows.
CREATE OR REPLACE FUNCTION app_document_readable(p_document_id uuid, p_kb_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS
$$
DECLARE
  v_user uuid := app_current_user_id();
  v_allowed boolean;
BEGIN
  IF app_is_service() THEN RETURN true; END IF;
  IF v_user IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM app_visible_kb_ids() k WHERE k = p_kb_id) THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
    WHERE ur."userId" = v_user
      AND (r.name IN ('系统管理员', '超级管理员') OR r.permissions::text LIKE '%"*"%')
  ) THEN RETURN true; END IF;

  IF EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = p_kb_id AND a."userId" = v_user)
    OR EXISTS (SELECT 1 FROM "KnowledgeBase" k WHERE k.id = p_kb_id AND k."ownerUserId" = v_user)
  THEN RETURN true; END IF;

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
$$;
