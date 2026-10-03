-- 20261003000000_force_rls_core_tenant_tables
--
-- The tenant-isolation migration (20260922200000) enabled row level security on
-- the core tenant tables but never forced it. `ENABLE ROW LEVEL SECURITY` alone
-- exempts the table owner from every policy, so any session running as the owner
-- role (the migration role, `llmwiki`, or an operator psql session) reads and
-- writes every tenant's rows regardless of the policies that exist.
--
-- The API connects as the dedicated NOBYPASSRLS runtime role, so the online path
-- was already covered. The remaining exposure is the owner class of session:
-- migrations, backfills, maintenance scripts and any human who connects with the
-- owner credentials. FORCE ROW LEVEL SECURITY closes that gap by making the
-- policies apply to the owner too.
--
-- This is deliberately additive and idempotent: it only forces tables that
-- already have RLS enabled, so it can run on any instance regardless of which
-- earlier migrations were applied.
--
-- Services that must legitimately read across tenants (the runtime bootstrap and
-- the migration role) own the tables and are covered by explicit
-- BYPASSRLS grants issued in the runtime-role migrations; they are unaffected.

DO $$
DECLARE
  t text;
  enabled boolean;
  forced boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- Core knowledge content and its derived projections.
    'Document',
    'Chunk',
    'KnowledgeBase',
    'GraphEntity',
    'GraphRelation',
    'RaptorNode',
    -- Access control and version linkage.
    'DocumentAcl',
    'DocumentVersionLink',
    -- Conversation state returned to users.
    'Conversation',
    'Message',
    'Citation',
    -- Connector ingestion surfaces.
    'ConnectorSource',
    'ConnectorRun',
    -- Immutable version / artifact chain (RLS enabled in 20260930120000).
    'DocumentVersion',
    'BlockArtifact',
    'IndexGeneration',
    'ArtifactDependency',
    'ArtifactManifest',
    'OriginalBlockSnapshot',
    -- Enrichment and dense generation state.
    'EnrichmentStage',
    'GenerationVector',
    'ActiveIndexGeneration',
    'LateContextVector',
    'GraphProjectionInput'
  ] LOOP
    -- Skip tables absent from this database rather than failing the migration.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'skip: table % does not exist', t;
      CONTINUE;
    END IF;

    SELECT c.relrowsecurity INTO enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = t;

    -- Forcing RLS on a table with no policy would make it fully unreadable to
    -- the owner; only force where policies already exist.
    SELECT c.relforcerowsecurity INTO forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = t;

    IF enabled IS NOT TRUE THEN
      RAISE NOTICE 'skip: RLS not enabled on %', t;
      CONTINUE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE NOTICE 'skip: no policy on %; forcing would lock the owner out', t;
      CONTINUE;
    END IF;

    IF forced IS TRUE THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    RAISE NOTICE 'forced: %', t;
  END LOOP;
END $$;
