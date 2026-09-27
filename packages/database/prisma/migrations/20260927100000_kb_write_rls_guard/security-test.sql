-- Run inside a transaction after migration.sql, then ROLLBACK. Fixed fixture
-- IDs are isolated by that rollback. llmwiki_app is the NOBYPASSRLS API role.
INSERT INTO "User" (id, username, "displayName", email, status, source)
VALUES
  ('d00d0000-0000-4000-8000-000000000001', 'rls-test-owner', 'RLS owner', 'rls-owner@example.invalid', 'active', 'manual'),
  ('d00d0000-0000-4000-8000-000000000002', 'rls-test-reader', 'RLS reader', 'rls-reader@example.invalid', 'active', 'manual');
INSERT INTO "KnowledgeBase" (id, type, name, "gitRepoUrl", "ownerUserId", status, "updatedAt")
VALUES ('d00d0000-0000-4000-8000-000000000003', 'industry', 'RLS fixture', 'db://rls-test',
        'd00d0000-0000-4000-8000-000000000001', 'active', now());
INSERT INTO "IndustryGrant" (id, "kbId", "subjectType", "subjectId", "grantedById")
VALUES ('d00d0000-0000-4000-8000-000000000004',
        'd00d0000-0000-4000-8000-000000000003', 'user',
        'd00d0000-0000-4000-8000-000000000002',
        'd00d0000-0000-4000-8000-000000000001');

SET LOCAL ROLE llmwiki_app;
SELECT set_config('app.user_id', 'd00d0000-0000-4000-8000-000000000002', true),
       set_config('app.service', 'off', true);
DO $$
DECLARE changed integer; rejected boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "KnowledgeBase" WHERE id = 'd00d0000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'Granted reader cannot read KB';
  END IF;
  UPDATE "KnowledgeBase" SET name = 'forged' WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'Granted reader updated KB'; END IF;
  DELETE FROM "KnowledgeBase" WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'Granted reader deleted KB'; END IF;
  BEGIN
    INSERT INTO "KnowledgeBase" (id, type, name, "gitRepoUrl", "ownerUserId", status, "updatedAt")
    VALUES ('d00d0000-0000-4000-8000-000000000005', 'personal', 'Forged owner',
            'db://forged', 'd00d0000-0000-4000-8000-000000000001', 'active', now());
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Reader forged another personal owner'; END IF;
END $$;

RESET ROLE;
INSERT INTO "KbAdmin" ("kbId", "userId")
VALUES ('d00d0000-0000-4000-8000-000000000003', 'd00d0000-0000-4000-8000-000000000002');
SET LOCAL ROLE llmwiki_app;
DO $$
DECLARE changed integer; rejected boolean := false;
BEGIN
  UPDATE "KnowledgeBase" SET name = 'administrator edit'
  WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'KbAdmin management was blocked'; END IF;
  BEGIN
    UPDATE "KnowledgeBase" SET type = 'personal'
    WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'KbAdmin forged KB type'; END IF;
  rejected := false;
  BEGIN
    UPDATE "KnowledgeBase" SET status = 'privileged'
    WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'KbAdmin forged KB status'; END IF;
END $$;

SELECT set_config('app.user_id', 'd00d0000-0000-4000-8000-000000000001', true);
DO $$
DECLARE changed integer; rejected boolean := false;
BEGIN
  BEGIN
    UPDATE "KnowledgeBase" SET name = 'creator edit'
    WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Industry creator edited content without KbAdmin'; END IF;
  UPDATE "KnowledgeBase" SET status = 'archived'
  WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'Industry creator archive was blocked'; END IF;
  rejected := false;
  BEGIN
    UPDATE "KnowledgeBase" SET "ownerUserId" = 'd00d0000-0000-4000-8000-000000000002'
    WHERE id = 'd00d0000-0000-4000-8000-000000000003';
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Owner reassignment was accepted'; END IF;
END $$;
RESET ROLE;
