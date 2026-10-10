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

The complete `pnpm test` output is in [pnpm-test.log](./pnpm-test.log). These tests and the build ran locally; no production request or database write was made by the verification process.

## Demo deployment verification

After deployment, read-only checks on `ubuntu@150.158.137.151` showed `llmwiki-api`, `llmwiki-web`, and `llmwiki-parser` active. API `/ready` returned 200 with database and Redis checks `ok`; its `apiReleaseFingerprint` (`bb2e4184c279fc7da4a557b0ef86c5987c367697c18a261bba97adbbfde9c9ac`) matched the remote `compiledApiIdentity` calculation. The remote compiled `semantic-cache.service.js` had SHA-256 `2f730b1a4c5234df0ab57c359f980ad1d11001efe1b9ca46a8d2d7119142d9ba` and contained both the `double precision` cast and numeric normalization. The web app returned HTTP 200 on port 50003 locally and through the demo address.

No authorized live-test credentials were available to this verification process, so it did not create a conversation or repeat the user question. This report does not claim that the original issue was re-tested through a live chat session.

## Release-candidate build

The release commit is `a9ca0d381232cb3416e0fbc99cc2baf30a9cf348`. `pnpm build` exited 0 with all four Turbo tasks restored from cache. Then `pnpm run build --force` exited 0 and executed all four tasks locally with no cache hits. Logs are [pnpm-build.log](./pnpm-build.log) and [pnpm-build-forced.log](./pnpm-build-forced.log). The compiled cache query contains `1.0::double precision AS similarity` and normalizes the result with `Number(row.similarity ?? 1)`.

The forced-build output fingerprints are recorded in [artifact-fingerprint.txt](./artifact-fingerprint.txt); combined artifact SHA-256: `609e3528eccc0b28f05df7c78ad3ec039b5a1c664fa46adf11c15706ccfed272`.

## Production deployment verification

The production release was deployed by the release operator with `bash scripts/deploy-prod.sh --target=inst1 --skip-build --skip-gate`; it exited 0 and created snapshot `20261010021359`. This verification only made read-only health and artifact checks; it did not submit a chat question or write business data.

At 2026-10-10 10:18 CST, the production system units `llmwiki-api`, `llmwiki-web`, and `llmwiki-parser` were all `active`. `http://127.0.0.1:3000/ready` returned HTTP 200 with database and Redis `ok`, and reported API fingerprint `bb2e4184c279fc7da4a557b0ef86c5987c367697c18a261bba97adbbfde9c9ac`. The public `http://knowledge.5gsailor.com:20080/` returned HTTP 307 to HTTPS; following the redirect returned HTTP 200. The remotely calculated API identity matched the candidate build. Production `apps/api/dist/chat/semantic-cache.service.js` SHA-256 was `2f730b1a4c5234df0ab57c359f980ad1d11001efe1b9ca46a8d2d7119142d9ba`, matching the candidate; the compiled file contains both `1.0::double precision AS similarity` and `Number(row.similarity ?? 1)`.

Read-only `journalctl` inspection for `llmwiki-api` since the deployment window found zero matches for assistant-message persistence failures, Prisma `message.create` validation failures, `constructor: [object Function]`, or serialization of `[object Function]`. This is a log health check, not a live chat regression claim.

The deployment log reports 85 Prisma migrations found and no pending Prisma migrations. It also reports Knowledge/shared-skills migration `v0.53.0` as **PARTIAL**: 13 sources require host action. No export or vendor upgrade was performed as part of this release verification; this remains a separate follow-up and is not represented as a successful full migration. Sanitized deployment logs are [demo-deploy.log](./demo-deploy.log) and [production-deploy.log](./production-deploy.log). Structured read-only production results are in [production-postdeploy.json](./production-postdeploy.json).
