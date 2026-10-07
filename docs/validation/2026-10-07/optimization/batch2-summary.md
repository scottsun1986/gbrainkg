# Optimization verification batch 2 (2026-10-07)

All commands were run from `/home/scottsun/gbrainkg`; no source or test files were edited.

| Check | Result | Counts / detail |
|---|---:|---|
| `node tests/integration/redis-reconnect.cjs` | exit 1 | Assertion reported `Expected values to be strictly equal: false !== true`; log does not identify which assertion. No named `gbrain-redis-fault-*` container remained after the run. |
| `python3 -m unittest discover -s tests/evaluation/core-flow -p 'test_paired_gate.py'` | exit 0 | 4 tests passed. |
| `python3 -m unittest discover -s tests/e2e -p 'test_session_cache.py'` | exit 0 | 2 tests passed. |
| `pnpm benchmark:ann-recall:selftest` | exit 0 | `ann_recall_eval selftest OK`. |
| `JEST_PROBE_AFTER_MS=50000 CORE_AUTH_ENFORCE=0 CORE_VERSIONING_ENABLED=0 CORE_GRAPH_INCREMENTAL_ENABLED=0 LLMWIKI_ALLOW_DEV_SECRET=1 timeout 75s node -r ../../tests/integration/jest-handle-probe.cjs node_modules/jest/bin/jest.js --detectOpenHandles --runInBand` (cwd `apps/api`) | exit 124 (timeout) | Jest summary: 159 suites passed, 1 failed, 1 skipped (160 of 161); 1,367 tests passed, 1 failed, 5 skipped (1,373 total). Jest completed its suite run in 36.677s, but process stayed alive until timeout. |

## Jest failure and live resources

The failing test was `ChatService › does not claim a full outline when the source scan is truncated`. Exact source stack location: `apps/api/src/chat/deterministic-scan.ts:37:46`, where the duplicate cursor check throws `Deterministic scan made no progress`.

At the 50s async-hooks snapshot, two referenced resources remained:

- `TCPWRAP`: creation stack points to `node_modules/.pnpm/ioredis@5.11.1/node_modules/ioredis/built/connectors/StandaloneConnector.js:54:66`.
- `TLSWRAP`: creation stack points into Node’s bundled undici at `node:internal/deps/undici/undici:2651:24` (`Client.connect`) and `:8032:29` (`socket`). The diagnostic does not identify an application caller for this TLS connection.

These are the observed live handles at the snapshot; ownership beyond those stacks is undetermined.

Full logs and per-command exit codes are in `docs/validation/2026-10-07/optimization/batch2-*.log` and `.exit`.
