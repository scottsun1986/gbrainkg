# Chat cache persistence regression — 2026-10-10

## Root-cause evidence

The reported production failure was diagnosed from the existing read-only application log at `/tmp/chat-save-prod-log.txt:3688` and `:3759`, where `constructor: [object Function]` reaches Prisma JSON serialization; no production request or database operation was performed during this verification.

On the local PostgreSQL target configured by `apps/api/.env` (`localhost:5433/llmwiki`), a read-only Prisma query returned `pg_typeof(1.0) = numeric` and `pg_typeof(1.0::double precision) = double precision`. The raw Prisma result for `1.0 AS similarity` was an object and `instanceof Prisma.Decimal` was true; the cast result was a JavaScript `number` (`Number` constructor). No tables were read or written by this check.

The regression test follows the failing path: Prisma Decimal from cache L2 lookup → L1 promotion and lookup → `ChatTraceRecorder.finish` → Prisma `serializeJsonQuery`. It verifies the original Decimal trace fails serialization because of its constructor function and that normalized L2/L1 results serialize successfully. The controller test verifies save failures return the generic `回答保存失败，请重试。` response without exposing Prisma input details.

## Verification

| Command | Result |
| --- | --- |
| `pnpm --filter api run test --runInBand semantic-cache.service.spec.ts chat.controller.spec.ts` | Passed: 2 suites, 25 tests |
| `pnpm test` | Passed: Turbo 6/6 tasks; API Jest 187 suites passed, 1 skipped; 1,642 tests passed, 5 skipped; web TAP 86 passed, 0 failed |
| `pnpm --filter api lint` | Passed |
| `pnpm --filter api build` | Passed |
| `git diff --check` | Passed |

The initial command `pnpm --filter api test --runInBand ...` was rejected by pnpm's option parser before Jest started. The first corrected Jest run exposed a TypeScript-only test-fixture typing error; that fixture was narrowed and the final targeted run above passed. No failures remain in the requested checks.

The complete `pnpm test` output is in [pnpm-test.log](./pnpm-test.log). Verification ran locally. No production request, write, or deployment was made.
