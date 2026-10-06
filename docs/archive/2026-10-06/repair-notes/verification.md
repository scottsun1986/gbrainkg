# Repair verification log — 2026-10-06

Scope: local verification only. No production services, restarts, paid model calls, or online quality evaluations were used. Full command output is under `/tmp` as listed below. Database checks target only `gbrain_core_opt_test_repair_20261006` on the local Docker PostgreSQL instance at port 5433.

## Completed checks

| Command | Result | Log / limits |
|---|---|---|
| `pnpm --filter database exec prisma generate --schema prisma/schema.prisma` | PASS; Prisma Client 5.22 generated | `/tmp/prisma-generate-repair.log` |
| `pnpm --filter api exec tsc --noEmit` | FAIL; generated client types lack `User.mfaLastCounter`, `BrainChangeEvent.claimToken`, and `ChatRun.leaseExpiresAt` referenced by API code | `/tmp/api-typecheck-repair.log`; schema/API work was still in progress |
| `pnpm --filter api lint` | PASS, no lint errors | `/tmp/api-lint-repair.log` |
| `pnpm --filter web exec tsc --noEmit` | PASS | `/tmp/web-typecheck-repair.log` |
| `pnpm --filter web lint` | PASS, 0 errors and 128 warnings | `/tmp/web-lint-repair.log` |
| `pnpm --filter web build` | PASS; Next.js production build and page generation completed | `/tmp/web-build-repair.log`; build only, no deployment |
| `pnpm --filter web test` | PASS, 66 tests passed | `/tmp/web-test-current.log` |
| `pnpm test:parser` | PASS, 54 tests and 4 subtests passed | `/tmp/parser-test-repair.log`; parser regression fixed since first run (initial failing run summarized in `/tmp/stage1-verification-notes.md`) |
| `pnpm test:adapter` | PASS, build succeeded and 17/17 contract tests passed | `/tmp/adapter-test-repair.log` |
| `cd apps/parser-worker && python3 -m ruff check .` | PASS | `/tmp/parser-ruff-repair.log` |
| `cd apps/parser-worker/src && python3 -m mypy --explicit-package-bases main.py quality.py extractors` | PASS, 5 source files | `/tmp/parser-mypy-repair.log`. This is the documented invocation in `apps/parser-worker/pyproject.toml`; the broader `python3 -m mypy src` invocation from the package root reports duplicate module naming and is not the configured check |
| `bash -n scripts/ab-gate.sh scripts/ci.sh scripts/deploy-prod.sh scripts/feedback-gate.sh scripts/reconcile-runtime-db-role.sh scripts/release-functional-gate.sh scripts/rls-inspect.sh scripts/verify-runtime-rls.sh` | PASS | `/tmp/shell-syntax-repair.log`; syntax check only, no scripts were run against a live service |
| `python3 -m py_compile scripts/assert-test-target.py` | PASS | `/tmp/python-syntax-repair.log` |
| `pnpm benchmark:selftest` | FAIL in `tests/evaluation/quality-gate-judge.selftest.ts:143`; actual output contained only the gate header, missing expected `2 enabled live gate(s) failed`. The earlier `test_sota_gate_results.py` fixture failure no longer reproduces in this run | `/tmp/benchmark-selftest-repair.log`; chain stops at this failing check, so later selftests in the script were not run |
| `git diff --check` | PASS on the latest run | `/tmp/diff-check-repair.log`; an earlier run found trailing whitespace at `apps/web/src/components/admin/AdminScreen.tsx:75`, subsequently absent |
| `pnpm test` | FAIL; Turbo completed with 10 failed suites, 1 skipped, 136 passed (147 total); 25 failed tests, 5 skipped, 1257 passed (1287 total). Failures include API mocks/contracts around new Prisma fields, MCP permit expectations, chat stream persistence, knowledge graph cache and ACL mocks | `/tmp/pnpm-test-repair.log`; API client was generated from the then-current schema, which did not yet expose the fields above |

## Isolated PostgreSQL migration attempt

The database `gbrain_core_opt_test_repair_20261006` was confirmed absent, then created on the local Docker PostgreSQL service (`llmwiki-postgres`, host port 5433). No other database was changed.

Command: `pnpm --filter database exec prisma migrate deploy --schema prisma/schema.prisma`, with `DATABASE_URL` privately redirected to that exact test database. Result: FAIL at migration `20260927100000_kb_write_rls_guard` (Prisma P3018 / SQLSTATE P0001). The migration explicitly recognizes only `llmwiki` and `llmwiki_instN` database names and raises `Unknown runtime role mapping` for the requested test database name. The failing migration is recorded in this isolated database; later migrations, `security-test.sql`, `scripts/verify-runtime-rls.sql`, and `tests/integration/run-core-checks.py` were therefore not run. Log: `/tmp/db-migrate-repair.log`.

The DB migration check needs a deliberate test strategy before it can complete: preserve the exact requested database name and add supported test-name mapping in the migration design, or use a temporary supported instance-name alias while migrating and restore the requested name afterward. No workaround was applied in this verification pass.

## Stage 1 web evidence

The first web checks passed lint but exposed TypeScript errors; after `web_fixes` changes, typecheck and tests passed as recorded above. Initial full logs are `/tmp/web-lint-current.log`, `/tmp/web-typecheck-current.log`; stage notes: `/tmp/stage1-verification-notes.md`.
