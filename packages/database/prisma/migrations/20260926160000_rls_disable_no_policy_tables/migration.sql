-- Only these reviewed, app-mediated/internal tables are intentionally without
-- RLS policies. Engine bootstrap may enable RLS on them; an unknown table must
-- fail closed so a new tenant-bearing table is never silently exposed.
DO $$
DECLARE
  allowed text[] := ARRAY[
    -- Application metadata/auth tables without row policies (API authorization).
    'AuditLog', 'BrainChangeEvent', 'BrainDerivedPage', 'BrainMaintenanceRun',
    'BrainOperationLog', 'BrainRepo', 'BrainScope', 'BrainScopeMember',
    'BrainSource', 'BrainSourceDocument', 'BrainSourceMember', 'BrainTopic',
    'ChunkLexicalDoc', 'ChunkSparseEmbedding', 'CompileJob',
    'ContextualPrefixCache', 'EmbeddingModelState', 'FeedbackCase',
    'GraphCommunity', 'IndustryGrant', 'KbAdmin', 'KbLexicalStat',
    'KbModelOverride', 'LexicalTermStat', 'ModelConfig', 'ModelProvider',
    'OrgAdmin', 'OrgNode', 'Role', 'SemanticCache', 'SystemSetting',
    'User', 'UserCredential', 'UserOrg', 'UserRole', '_prisma_migrations',
    -- GBrain engine-owned internal state (engine governs its own access).
    'access_tokens', 'budget_ledger', 'budget_reservations',
    'calibration_profiles', 'chat_usage_log', 'code_edges_chunk',
    'code_edges_symbol', 'code_traversal_cache', 'config', 'content_chunks',
    'context_volunteer_events', 'conversation_parser_llm_cache',
    'dream_verdicts', 'drift_decisions', 'entity_identities',
    'eval_candidates', 'eval_capture_failures', 'eval_contradictions_cache',
    'eval_contradictions_runs', 'eval_takes_quality_runs',
    'extract_atoms_page_state', 'extract_atoms_transcript_state',
    'extract_rollup_7d', 'fact_withdrawals', 'facts',
    'file_migration_ledger', 'files', 'gbrain_cycle_locks', 'ingest_log',
    'links', 'loop_suppressions', 'mcp_request_log', 'mcp_spend_log',
    'mcp_spend_reservations', 'migration_impact_log', 'minion_attachments',
    'minion_budget_log', 'minion_inbox', 'minion_jobs',
    'minion_lease_pressure_log', 'minion_self_fix_log', 'oauth_clients',
    'oauth_codes', 'oauth_grant_audit', 'oauth_tokens',
    'op_checkpoint_paths', 'op_checkpoints', 'open_loops', 'page_aliases',
    'page_generation_clock', 'page_projection_jobs', 'page_versions',
    'page_write_guards', 'pages', 'persistence_brain',
    'persistence_counters', 'persistence_effects', 'persistence_host_bindings',
    'persistence_local_writers', 'persistence_requests',
    'persistence_source_bindings', 'persistence_topology_changes',
    'persistence_worktrees', 'persistence_writer_protocols', 'query_cache',
    'raw_data', 'search_telemetry', 'session_context_state',
    'shared_skill_delivery_batches', 'shared_skill_heads',
    'shared_skill_members', 'shared_skill_packs', 'shared_skill_policies',
    'shared_skill_policy_audit', 'shared_skill_revision_leases',
    'shared_skill_revisions', 'shared_skill_state', 'slug_aliases',
    'source_ingestion_receipts', 'sources', 'subagent_messages',
    'subagent_rate_leases', 'subagent_tool_executions',
    'synthesis_evidence', 'tags', 'take_domain_assignments',
    'take_grade_cache', 'take_nudge_log', 'take_proposals', 'takes',
    'think_ab_results', 'timeline_entries'
  ];
  unknown_tables text[];
  t text;
  n integer := 0;
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO unknown_tables
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = c.relname
    )
    AND NOT (c.relname = ANY(allowed));

  IF unknown_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Policyless RLS on unreviewed table(s): %', unknown_tables;
  END IF;

  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname = ANY(allowed)
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      )
  LOOP
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'RLS disabled on % reviewed internal table(s)', n;
END $$;
