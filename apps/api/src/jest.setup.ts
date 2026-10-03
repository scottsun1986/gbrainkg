/**
 * Jest global setup.
 *
 * Two problems this fixes, both of which made a green local run depend on the
 * developer's apps/api/.env:
 *
 * 1. Core feature flags. `src/prisma.ts` loads `.env` at import time into
 *    process.env, so a local `CORE_GRAPH_INCREMENTAL_ENABLED=1` (or
 *    CORE_VERSIONING_ENABLED) changed behaviour inside specs that assert the
 *    legacy code path. Setting them here runs before any test module — and
 *    before prisma.ts — is imported, so the suite is deterministic regardless
 *    of the machine.
 *
 * 2. Production-only guards. `authSigningSecret()` now refuses to sign with a
 *    fallback literal, which is the intended production behaviour, so the test
 *    environment must supply a real secret explicitly rather than inherit
 *    whatever the developer happens to have configured.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.RLS_ENFORCE = process.env.RLS_ENFORCE || '0';
process.env.CORE_AUTH_ENFORCE = '0';
process.env.CORE_VERSIONING_ENABLED = '0';
process.env.CORE_GRAPH_INCREMENTAL_ENABLED = '0';
process.env.ADAPTIVE_RETRIEVAL_ENABLED = process.env.ADAPTIVE_RETRIEVAL_ENABLED || '0';
// Long enough to satisfy the AUTH_SECRET length requirement; test-only value.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'llmwiki-jest-suite-secret-0123456789';
