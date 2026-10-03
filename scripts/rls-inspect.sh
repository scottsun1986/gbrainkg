#!/usr/bin/env bash
# Read-only inspection of the RLS state on a deployed instance.
# Usage: bash rls-inspect.sh <env-file>
set -euo pipefail
ENV_FILE="${1:?env file required}"
URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"'")
URL=$(printf '%s' "$URL" | sed 's/[?&]schema=[^&]*//')
psql "$URL" -X -A -F' | ' -t <<'SQL'
SELECT 'forced', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity
UNION ALL
SELECT 'enabled_not_forced', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity
UNION ALL
SELECT 'policies_total', count(*)::text FROM pg_policies WHERE schemaname='public';
SQL
echo "--- core tables: relrowsecurity / relforcerowsecurity / policies ---"
psql "$URL" -X -A -F' | ' -t <<'SQL'
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
  AND c.relname IN ('Document','Chunk','KnowledgeBase','GraphEntity','GraphRelation','RaptorNode',
                    'DocumentAcl','DocumentVersionLink','Conversation','Message','Citation',
                    'ConnectorSource','ConnectorRun')
ORDER BY c.relname;
SQL