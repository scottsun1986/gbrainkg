-- RLS 纵深防御：应用层 ACL 之外的数据库级隔离。
-- 运行时角色必须 NOBYPASSRLS；迁移/GBrain 维护角色保留 BYPASSRLS。
-- Fail-closed：未显式声明 app.user_id 或 app.service=on 时拒绝读取租户数据。

-- ---------- 企业字段 ----------
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "storageProvider" text NOT NULL DEFAULT 'local';
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "objectKey" text;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "sensitivity" text NOT NULL DEFAULT 'internal';
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "language" text;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "contentHash" text;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "sourceExternalId" text;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "sourceCursor" text;
CREATE INDEX IF NOT EXISTS "Document_sourceExternalId_idx" ON "Document"("sourceExternalId");
CREATE INDEX IF NOT EXISTS "Document_contentHash_kb_idx" ON "Document"("kbId", "contentHash");

ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS "parentChunkId" uuid;
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS "contentHash" text;
CREATE INDEX IF NOT EXISTS "Chunk_parentChunkId_idx" ON "Chunk"("parentChunkId");
CREATE INDEX IF NOT EXISTS "Chunk_contentHash_idx" ON "Chunk"("contentHash");

-- 文档级 ACL（覆盖 KB 级可见性；空 = 继承 KB）
CREATE TABLE IF NOT EXISTS "DocumentAcl" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "documentId" uuid NOT NULL REFERENCES "Document"("id") ON DELETE CASCADE,
  "subjectType" TEXT NOT NULL, -- user/role/org
  "subjectId" uuid NOT NULL,
  "permission" TEXT NOT NULL DEFAULT 'read',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "DocumentAcl_documentId_idx" ON "DocumentAcl"("documentId");
CREATE INDEX IF NOT EXISTS "DocumentAcl_subject_idx" ON "DocumentAcl"("subjectType", "subjectId");

-- 文档版本链边（supersedesDocumentId 之外的显式版本事件）
CREATE TABLE IF NOT EXISTS "DocumentVersionLink" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fromDocumentId" uuid NOT NULL REFERENCES "Document"("id") ON DELETE CASCADE,
  "toDocumentId" uuid NOT NULL REFERENCES "Document"("id") ON DELETE CASCADE,
  "relation" TEXT NOT NULL DEFAULT 'supersedes', -- supersedes/revision/translation
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("fromDocumentId", "toDocumentId", "relation")
);
CREATE INDEX IF NOT EXISTS "DocumentVersionLink_to_idx" ON "DocumentVersionLink"("toDocumentId");

-- 连接器同步状态
CREATE TABLE IF NOT EXISTS "ConnectorSource" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kbId" uuid NOT NULL REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL, -- feishu_drive/feishu_wiki/git/generic_webhook
  "name" TEXT NOT NULL,
  "config" JSONB NOT NULL DEFAULT '{}',
  "cursor" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "lastSyncAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ConnectorSource_kb_idx" ON "ConnectorSource"("kbId", "status");

CREATE TABLE IF NOT EXISTS "ConnectorRun" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sourceId" uuid NOT NULL REFERENCES "ConnectorSource"("id") ON DELETE CASCADE,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'running',
  "fetched" INTEGER NOT NULL DEFAULT 0,
  "ingested" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "detail" JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "ConnectorRun_source_idx" ON "ConnectorRun"("sourceId", "startedAt" DESC);

-- ---------- 会话辅助函数 ----------
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_service() RETURNS boolean
LANGUAGE sql STABLE AS
$$
  SELECT COALESCE(current_setting('app.service', true), '') = 'on'
$$;

-- 与 permission.service.getVisibleKnowledgeBases 对齐的可见 KB 集合。
-- SECURITY DEFINER：可读组织/授权元表，自身不被 RLS 拦截。
CREATE OR REPLACE FUNCTION app_visible_kb_ids() RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS
$$
DECLARE
  v_user uuid := app_current_user_id();
  v_admin boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(bool_or(r.name IN ('系统管理员', '超级管理员') OR r.permissions::text LIKE '%"*"%'), false)
    INTO v_admin
  FROM "UserRole" ur
  JOIN "Role" r ON r.id = ur."roleId"
  WHERE ur."userId" = v_user;

  -- 系统管理员：全部组织库/行业库 + 本人管理的库
  IF v_admin THEN
    RETURN QUERY
      SELECT DISTINCT k.id FROM "KnowledgeBase" k
      WHERE k.status = 'active'
        AND (k.type IN ('org', 'industry')
             OR k."ownerUserId" = v_user
             OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = v_user)
             OR (k.type = 'personal' AND k."ownerUserId" = v_user));
    RETURN;
  END IF;

  -- 个人库：仅 owner
  RETURN QUERY
    SELECT k.id FROM "KnowledgeBase" k
    WHERE k.type = 'personal' AND k."ownerUserId" = v_user AND k.status = 'active';

  -- 直接管理（kbAdmin/owner，非 personal 由上面覆盖）
  RETURN QUERY
    SELECT k.id FROM "KnowledgeBase" k
    WHERE k.type <> 'personal' AND k.status = 'active'
      AND (k."ownerUserId" = v_user
           OR EXISTS (SELECT 1 FROM "KbAdmin" a WHERE a."kbId" = k.id AND a."userId" = v_user));

  -- 组织库：本人节点 + 全部祖先节点（只向上继承）
  RETURN QUERY
    WITH RECURSIVE org_up AS (
      SELECT o."orgNodeId" AS id
      FROM "UserOrg" o WHERE o."userId" = v_user
      UNION
      SELECT n."parentId" FROM "OrgNode" n
      JOIN org_up u ON n.id = u.id
      WHERE n."parentId" IS NOT NULL AND n.status = 'active'
    )
    SELECT k.id FROM "KnowledgeBase" k
    WHERE k.type = 'org' AND k.status = 'active' AND k."orgNodeId" IN (SELECT id FROM org_up);

  -- 行业库：user/role/org 三类主体，过期自动失效
  RETURN QUERY
    WITH RECURSIVE org_up AS (
      SELECT o."orgNodeId" AS id
      FROM "UserOrg" o WHERE o."userId" = v_user
      UNION
      SELECT n."parentId" FROM "OrgNode" n
      JOIN org_up u ON n.id = u.id
      WHERE n."parentId" IS NOT NULL AND n.status = 'active'
    ),
    subjects AS (
      SELECT 'user'::text AS subjectType, v_user::text AS subjectId
      UNION
      SELECT 'role', ur."roleId"::text FROM "UserRole" ur WHERE ur."userId" = v_user
      UNION
      SELECT 'org', id::text FROM org_up
    )
    SELECT g."kbId" FROM "IndustryGrant" g
    JOIN "KnowledgeBase" k ON k.id = g."kbId" AND k.type = 'industry' AND k.status = 'active'
    WHERE (g."subjectType", g."subjectId"::text) IN (SELECT subjectType, subjectId FROM subjects)
      AND (g."expiresAt" IS NULL OR g."expiresAt" > now());
END;
$$;

REVOKE ALL ON FUNCTION app_visible_kb_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_service() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_visible_kb_ids() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_service() TO PUBLIC;

-- 文档级 ACL：若存在覆盖行，则叠加过滤（deny-by-default for restricted docs）
CREATE OR REPLACE FUNCTION app_document_readable(p_document_id uuid, p_kb_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS
$$
DECLARE
  v_user uuid := app_current_user_id();
  v_has_acl boolean;
  v_allowed boolean;
BEGIN
  IF app_is_service() THEN
    RETURN true;
  END IF;
  IF v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_visible_kb_ids() k WHERE k = p_kb_id) THEN
    RETURN false;
  END IF;
  SELECT EXISTS (SELECT 1 FROM "DocumentAcl" WHERE "documentId" = p_document_id) INTO v_has_acl;
  IF NOT v_has_acl THEN
    RETURN true; -- 继承 KB 可见性
  END IF;
  WITH subjects AS (
    SELECT 'user'::text AS subjectType, v_user::text AS subjectId
    UNION
    SELECT 'role', ur."roleId"::text FROM "UserRole" ur WHERE ur."userId" = v_user
    UNION
    SELECT 'org', n.id::text
    FROM "UserOrg" uo
    JOIN "OrgNode" n ON n.id = uo."orgNodeId"
    WHERE uo."userId" = v_user
  )
  SELECT EXISTS (
    SELECT 1 FROM "DocumentAcl" a
    WHERE a."documentId" = p_document_id
      AND (a."subjectType", a."subjectId"::text) IN (SELECT subjectType, subjectId FROM subjects)
  ) INTO v_allowed;
  -- 知识库管理员始终可读
  IF NOT v_allowed AND EXISTS (
    SELECT 1 FROM "KbAdmin" ad WHERE ad."kbId" = p_kb_id AND ad."userId" = v_user
  ) THEN
    v_allowed := true;
  END IF;
  RETURN v_allowed;
END;
$$;

REVOKE ALL ON FUNCTION app_document_readable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_document_readable(uuid, uuid) TO PUBLIC;

-- ---------- RLS 策略 ----------
-- 模式：
--   app_is_service()           → 后台任务（ingest/embed/graph）
--   app_current_user_id() IS NOT NULL → 请求上下文，按可见 KB 收紧
--   两者皆无                    → 拒绝（fail-closed）

ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Chunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GraphEntity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GraphRelation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RaptorNode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeBase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentAcl" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentVersionLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectorSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectorRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Citation" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS doc_rw ON "Document";
CREATE POLICY doc_rw ON "Document" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND app_document_readable(id, "kbId"))
)
WITH CHECK (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids()))
);

DROP POLICY IF EXISTS chunk_rw ON "Chunk";
CREATE POLICY chunk_rw ON "Chunk" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND app_document_readable("documentId", "kbId"))
)
WITH CHECK (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids()))
);

DROP POLICY IF EXISTS kb_rw ON "KnowledgeBase";
CREATE POLICY kb_rw ON "KnowledgeBase" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND id IN (SELECT app_visible_kb_ids()))
)
WITH CHECK (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL)
);

DROP POLICY IF EXISTS graph_entity_rw ON "GraphEntity";
CREATE POLICY graph_entity_rw ON "GraphEntity" FOR ALL
USING (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())))
WITH CHECK (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())));

DROP POLICY IF EXISTS graph_relation_rw ON "GraphRelation";
CREATE POLICY graph_relation_rw ON "GraphRelation" FOR ALL
USING (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())))
WITH CHECK (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())));

DROP POLICY IF EXISTS raptor_rw ON "RaptorNode";
CREATE POLICY raptor_rw ON "RaptorNode" FOR ALL
USING (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())))
WITH CHECK (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())));

DROP POLICY IF EXISTS doc_acl_rw ON "DocumentAcl";
CREATE POLICY doc_acl_rw ON "DocumentAcl" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND app_document_readable("documentId", (SELECT "kbId" FROM "Document" WHERE id = "documentId")))
)
WITH CHECK (app_is_service());

DROP POLICY IF EXISTS version_link_rw ON "DocumentVersionLink";
CREATE POLICY version_link_rw ON "DocumentVersionLink" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND (
    app_document_readable("fromDocumentId", (SELECT "kbId" FROM "Document" WHERE id = "fromDocumentId"))
    OR app_document_readable("toDocumentId", (SELECT "kbId" FROM "Document" WHERE id = "toDocumentId"))
  ))
)
WITH CHECK (app_is_service());

DROP POLICY IF EXISTS connector_source_rw ON "ConnectorSource";
CREATE POLICY connector_source_rw ON "ConnectorSource" FOR ALL
USING (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())))
WITH CHECK (app_is_service() OR (app_current_user_id() IS NOT NULL AND "kbId" IN (SELECT app_visible_kb_ids())));

DROP POLICY IF EXISTS connector_run_rw ON "ConnectorRun";
CREATE POLICY connector_run_rw ON "ConnectorRun" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "sourceId" IN (
    SELECT s.id FROM "ConnectorSource" s WHERE s."kbId" IN (SELECT app_visible_kb_ids())
  ))
)
WITH CHECK (app_is_service());

DROP POLICY IF EXISTS conversation_rw ON "Conversation";
CREATE POLICY conversation_rw ON "Conversation" FOR ALL
USING (app_is_service() OR (app_current_user_id() IS NOT NULL AND "userId" = app_current_user_id()))
WITH CHECK (app_is_service() OR (app_current_user_id() IS NOT NULL AND "userId" = app_current_user_id()));

DROP POLICY IF EXISTS message_rw ON "Message";
CREATE POLICY message_rw ON "Message" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "conversationId" IN (
    SELECT id FROM "Conversation" WHERE "userId" = app_current_user_id()
  ))
)
WITH CHECK (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "conversationId" IN (
    SELECT id FROM "Conversation" WHERE "userId" = app_current_user_id()
  ))
);

DROP POLICY IF EXISTS citation_rw ON "Citation";
CREATE POLICY citation_rw ON "Citation" FOR ALL
USING (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "messageId" IN (
    SELECT m.id FROM "Message" m
    JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE c."userId" = app_current_user_id()
  ))
)
WITH CHECK (
  app_is_service()
  OR (app_current_user_id() IS NOT NULL AND "messageId" IN (
    SELECT m.id FROM "Message" m
    JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE c."userId" = app_current_user_id()
  ))
);


-- Global identity/org metadata is not tenant-scoped. GBrain migrations may
-- enable RLS on these tables; the NOBYPASSRLS runtime role must still be able
-- to bootstrap default roles and resolve org trees. Tenant isolation is enforced
-- on content tables above.
ALTER TABLE "Role" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgNode" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "UserOrg" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "UserRole" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgAdmin" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "KbAdmin" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "IndustryGrant" DISABLE ROW LEVEL SECURITY;


-- GBrain engine migrations may enable RLS on internal tables (files, page_aliases,
-- LexicalTermStat, BrainRepo, ...). The NOBYPASSRLS runtime role must be able to
-- run Brain/ingestion bootstrap writes. Re-assert: only content tables keep RLS.
DO $$
DECLARE r record;
  keep text[] := ARRAY[
    'Document','Chunk','KnowledgeBase','GraphEntity','GraphRelation','RaptorNode',
    'Conversation','Message','Citation','DocumentAcl','DocumentVersionLink',
    'ConnectorSource','ConnectorRun'];
BEGIN
  FOR r IN
    SELECT c.relname AS t FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
  LOOP
    IF NOT (r.t = ANY (keep)) THEN
      EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', r.t);
    END IF;
  END LOOP;
END $$;
