#!/usr/bin/env bash
# Read-only post-migration checks under both migrator and actual API credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "${1:?usage: verify-runtime-rls.sh <instance-env-file>}"
set +a
: "${DATABASE_URL:?migrator URL required}"
: "${DATABASE_URL_APP:?runtime URL required}"
clean_url() { python3 - "$1" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
u=urlsplit(sys.argv[1])
print(urlunsplit((u.scheme,u.netloc,u.path,urlencode([(k,v) for k,v in parse_qsl(u.query) if k!='schema']),u.fragment)))
PY
}
migration_url="$(clean_url "$DATABASE_URL")"
runtime_url="$(clean_url "$DATABASE_URL_APP")"
psql "$migration_url" -X -v ON_ERROR_STOP=1 -f "$ROOT/scripts/verify-runtime-rls.sql"
expected_documents=$(psql "$migration_url" -X -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM public."Document"')
[[ "$expected_documents" =~ ^[0-9]+$ ]] || { echo 'FAIL: invalid migrator document count' >&2; exit 1; }
psql "$runtime_url" -X -v ON_ERROR_STOP=1 -v expected_documents="$expected_documents" <<'SQL'
BEGIN READ ONLY;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
     OR EXISTS(SELECT 1 FROM pg_roles WHERE (rolsuper OR rolbypassrls) AND pg_has_role(current_user,oid,'MEMBER')) THEN
    RAISE EXCEPTION 'FAIL: API runtime role can bypass RLS';
  END IF;
END $$;
SELECT set_config('app.user_id','',true),set_config('app.service','off',true);
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public."Document") THEN RAISE EXCEPTION 'FAIL: unscoped runtime sees documents'; END IF;
END $$;
SELECT set_config('app.service','on',true);
SELECT count(*) = :'expected_documents'::bigint AS service_read_matches FROM public."Document" \gset
\if :service_read_matches
\else
  \echo 'FAIL: service context cannot read expected document rows'
  SELECT 1/0;
\endif
ROLLBACK;
SQL
echo 'PASS: structural RLS, runtime non-bypass and scoped read checks'
[[ "$expected_documents" != 0 ]] || echo 'NOTICE: empty corpus; positive service-read coverage requires isolated security fixtures'
