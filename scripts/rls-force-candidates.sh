#!/usr/bin/env bash
# Which RLS-enabled tables have policies but are not forced - these are exactly
# the tables migration 20261003000000 will FORCE. Read-only.
set -euo pipefail
ENV_FILE="${1:?env file required}"
URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"'")
URL=$(printf '%s' "$URL" | sed 's/[?&]schema=[^&]*//')
psql "$URL" -X -A -F' | ' -t <<'SQL'
SELECT c.relname, (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
  AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname)
ORDER BY c.relname;
SQL