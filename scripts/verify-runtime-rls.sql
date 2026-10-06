-- Read-only release invariants; historical migration files remain immutable.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$
DECLARE t text; offenders text[];
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Document','Chunk','KnowledgeBase','GraphEntity','GraphRelation','RaptorNode',
    'DocumentAcl','DocumentVersionLink','Conversation','Message','Citation',
    'ConnectorSource','ConnectorRun','ChatRun','AuthorizationState','ModelQuotaBucket',
    'UserCredential','ModelProvider','SemanticCache','BrainDerivedPage',
    'BrainScopeMember','BrainSourceMember','BrainSourceDocument','FeedbackCase',
    'User','UserRole','UserOrg','OrgNode','OrgAdmin','Role','KbAdmin','KbModelOverride',
    'IndustryGrant','ModelConfig','SystemSetting','EmbeddingModelState','AuditLog',
    'BrainRepo','BrainScope','BrainSource','BrainTopic','CompileJob','BrainChangeEvent',
    'BrainOperationLog','BrainMaintenanceRun','ChunkLexicalDoc','ChunkSparseEmbedding',
    'KbLexicalStat','LexicalTermStat','ContextualPrefixCache'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=t AND c.relkind IN ('r','p')
        AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)) THEN
      RAISE EXCEPTION 'FAIL: public.% must exist with enabled, forced RLS and a policy',t;
    END IF;
  END LOOP;
  -- The unsafe shape is "a policy exists but RLS is not FORCEd": the owning role
  -- then silently bypasses its own policies. A table that merely has RLS enabled
  -- with NO policy is deliberately out of scope — GBrain shares this database and
  -- enables RLS on its own tables (pages, content_chunks, minion_jobs, ...) with no
  -- policies by design. Flagging that made every deploy abort after migrating,
  -- which left the previous release running against a migrated schema.
  SELECT array_agg(c.relname ORDER BY c.relname) INTO offenders
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity
    AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)
    AND NOT c.relforcerowsecurity
    -- Known foreign tables that share this database but are not created by this
    -- repository's migrations. "AuthorizationRevision" belongs to the older
    -- lineage; forcing it would change another tool's security posture, so it is
    -- exempt here. Extend this list only for tables this repo does not own.
    AND c.relname <> 'AuthorizationRevision';
  IF offenders IS NOT NULL THEN RAISE EXCEPTION 'FAIL: unsafe RLS tables: %',offenders; END IF;
END $$;
ROLLBACK;
