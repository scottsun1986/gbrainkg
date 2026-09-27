-- Read visibility does not confer KB write permission. Keep the creator's
-- INSERT ... RETURNING path visible, but authorize writes by management scope.
CREATE OR REPLACE FUNCTION app_kb_system_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
    WHERE ur."userId" = p_user
      AND (r.builtin OR r.name IN ('系统管理员', '超级管理员') OR r.permissions ? '*')
  )
$$;

CREATE OR REPLACE FUNCTION app_kb_has_permission(p_user uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_kb_system_admin(p_user) OR EXISTS (
    SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId"
    WHERE ur."userId" = p_user AND r.permissions ? p_permission
  )
$$;

CREATE OR REPLACE FUNCTION app_kb_manages_org(p_user uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE ancestors AS (
    SELECT id, "parentId" FROM "OrgNode" WHERE id = p_org AND status = 'active'
    UNION ALL
    SELECT parent.id, parent."parentId" FROM "OrgNode" parent
    JOIN ancestors child ON parent.id = child."parentId"
    WHERE parent.status = 'active'
  )
  SELECT app_kb_system_admin(p_user) OR (
    app_kb_has_permission(p_user, 'org.user.manage') OR
    app_kb_has_permission(p_user, 'org.node.create')
  ) AND EXISTS (
    SELECT 1 FROM ancestors a WHERE
      EXISTS (SELECT 1 FROM "OrgAdmin" oa WHERE oa."orgNodeId" = a.id AND oa."userId" = p_user)
      OR (app_kb_has_permission(p_user, 'org.user.manage') AND EXISTS (
        SELECT 1 FROM "UserOrg" uo WHERE uo."orgNodeId" = a.id AND uo."userId" = p_user
      ))
  )
$$;

CREATE OR REPLACE FUNCTION app_kb_can_manage(
  p_id uuid, p_type text, p_owner uuid, p_org uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR (
    app_current_user_id() IS NOT NULL AND (
      (app_kb_system_admin(app_current_user_id()) AND p_type <> 'personal')
      OR (p_type = 'personal' AND p_owner = app_current_user_id())
      OR (p_type = 'industry' AND (
        p_owner = app_current_user_id() OR EXISTS (
          SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = p_id AND a."userId" = app_current_user_id()
        )
      ))
      OR (p_type = 'org' AND (
        (p_org IS NOT NULL AND app_kb_manages_org(app_current_user_id(), p_org))
        OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = p_id AND a."userId" = app_current_user_id())
        OR (p_org IS NULL AND p_owner = app_current_user_id())
      ))
    )
  )
$$;

CREATE OR REPLACE FUNCTION app_kb_can_create(
  p_type text, p_owner uuid, p_org uuid, p_status text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_service() OR (
    app_current_user_id() IS NOT NULL AND p_status = 'active' AND (
      (p_type = 'personal' AND p_owner = app_current_user_id() AND p_org IS NULL)
      OR (p_type = 'industry' AND p_owner = app_current_user_id() AND p_org IS NULL
          AND app_kb_has_permission(app_current_user_id(), 'kb.industry.create'))
      OR (p_type = 'org' AND p_owner IS NULL AND p_org IS NOT NULL
          AND app_kb_manages_org(app_current_user_id(), p_org))
    )
  )
$$;

-- A manager may edit content and archive/reactivate through the app, but may
-- not turn a visible KB into another tenant's KB or forge ownership/type.
CREATE OR REPLACE FUNCTION app_kb_guard_structure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_is_service() THEN RETURN NEW; END IF;
  IF NEW.type IS DISTINCT FROM OLD.type
     OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
     OR NEW."orgNodeId" IS DISTINCT FROM OLD."orgNodeId" THEN
    RAISE EXCEPTION 'KB type, owner and organization cannot be changed by a request';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status = 'archived')
    OR (OLD.type = 'org' AND OLD.status = 'archived' AND NEW.status = 'active')
  ) THEN
    RAISE EXCEPTION 'Invalid KB status transition';
  END IF;
  -- An industry creator keeps archive authority, while content maintenance
  -- belongs to the currently assigned KbAdmin (or a system administrator).
  IF OLD.type = 'industry' AND OLD."ownerUserId" = app_current_user_id()
     AND NOT app_kb_system_admin(app_current_user_id())
     AND NOT EXISTS (
       SELECT 1 FROM "KbAdmin" a
       WHERE a."kbId" = OLD.id AND a."userId" = app_current_user_id()
     ) AND (to_jsonb(NEW) - 'status' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updatedAt') THEN
    RAISE EXCEPTION 'Industry creator may only archive without KbAdmin assignment';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kb_guard_structure ON "KnowledgeBase";
CREATE TRIGGER kb_guard_structure BEFORE UPDATE ON "KnowledgeBase"
FOR EACH ROW EXECUTE FUNCTION app_kb_guard_structure();

DROP POLICY IF EXISTS kb_rw ON "KnowledgeBase";
CREATE POLICY kb_read ON "KnowledgeBase" FOR SELECT USING (
  app_is_service() OR (
    app_current_user_id() IS NOT NULL AND (
      id IN (SELECT app_visible_kb_ids()) OR "ownerUserId" = app_current_user_id()
      OR app_kb_can_manage(id, type, "ownerUserId", "orgNodeId")
    )
  )
);
CREATE POLICY kb_insert ON "KnowledgeBase" FOR INSERT WITH CHECK (
  app_kb_can_create(type, "ownerUserId", "orgNodeId", status)
);
CREATE POLICY kb_update ON "KnowledgeBase" FOR UPDATE
USING (app_kb_can_manage(id, type, "ownerUserId", "orgNodeId"))
WITH CHECK (app_kb_can_manage(id, type, "ownerUserId", "orgNodeId"));
CREATE POLICY kb_delete ON "KnowledgeBase" FOR DELETE
USING (app_kb_can_manage(id, type, "ownerUserId", "orgNodeId"));

REVOKE ALL ON FUNCTION app_kb_system_admin(uuid), app_kb_has_permission(uuid, text),
  app_kb_manages_org(uuid, uuid), app_kb_can_manage(uuid, text, uuid, uuid),
  app_kb_can_create(text, uuid, uuid, text), app_kb_guard_structure() FROM PUBLIC;
DO $$
DECLARE
  candidate_roles text[];
  runtime_role text;
  granted integer := 0;
BEGIN
  -- The original inst1 uses database llmwiki, but deployments may name its
  -- NOBYPASSRLS runtime role llmwiki_app or llmwiki_app_inst1.
  candidate_roles := CASE
    WHEN current_database() = 'llmwiki' THEN ARRAY['llmwiki_app', 'llmwiki_app_inst1']
    WHEN current_database() ~ '^llmwiki_inst[0-9]+$'
      THEN ARRAY[replace(current_database(), 'llmwiki_inst', 'llmwiki_app_inst')]
    ELSE NULL
  END;
  IF candidate_roles IS NULL THEN
    RAISE EXCEPTION 'Unknown runtime role mapping for database %', current_database();
  END IF;
  FOR runtime_role IN
    SELECT rolname FROM pg_roles WHERE rolname = ANY(candidate_roles)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role AND (rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'Runtime role % must be NOBYPASSRLS', runtime_role;
    END IF;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app_kb_can_manage(uuid, text, uuid, uuid), app_kb_can_create(text, uuid, uuid, text) TO %I',
      runtime_role
    );
    granted := granted + 1;
  END LOOP;
  IF granted = 0 THEN
    RAISE EXCEPTION 'Expected runtime role is missing for database %', current_database();
  END IF;
END $$;
