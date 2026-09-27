#!/usr/bin/env bash
# ==============================================================================
# Heal tables left with RLS enabled but ZERO policies.
# ==============================================================================
# Why this exists: gbrain engine bootstrap (0.58.x) enables ROW LEVEL SECURITY
# across the whole shared schema. gbrain-native installs are unaffected (the
# connecting role owns the tables → owner bypass), but this platform runs a
# NOBYPASSRLS runtime role, so policy-less RLS denies every row and the API
# cannot boot. Run this after every gbrain engine upgrade on any database the
# engine touches. Idempotent; a healthy database is a no-op.
#
# Usage:
#   bash scripts/heal-rls-no-policy-tables.sh <db> [user] [host] [port]
#   e.g. bash scripts/heal-rls-no-policy-tables.sh llmwiki
#        bash scripts/heal-rls-no-policy-tables.sh llmwiki_inst2
# Run as the BYPASSRLS migrator role (default llmwiki). Password via PGPASSWORD
# or ~/.pgpass. In containerized dev: docker exec -i llmwiki-postgres psql ... < this file's SQL.
set -euo pipefail

DB="${1:?usage: heal-rls-no-policy-tables.sh <db> [user] [host] [port]}"
USER_ARG="${2:-llmwiki}"
HOST_ARG="${3:-127.0.0.1}"
PORT_ARG="${4:-5432}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEWED_SQL="$SCRIPT_DIR/../packages/database/prisma/migrations/20260926160000_rls_disable_no_policy_tables/migration.sql"
PGPASSWORD="${PGPASSWORD:-}" psql -h "$HOST_ARG" -p "$PORT_ARG" -U "$USER_ARG" -d "$DB" -v ON_ERROR_STOP=1 -1 -f "$REVIEWED_SQL"
echo "[heal-rls] $DB done"
