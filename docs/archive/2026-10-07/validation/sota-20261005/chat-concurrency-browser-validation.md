# Chat concurrency browser proof — 2026-10-05

## Runtime identity

- Local service: `llmwiki-web.service`, `http://localhost:3200`, active after restart.
- Service working directory: `/home/scottsun/gbrainkg/apps/web`; drop-in sets `NEXT_DIST_DIR=.next-live`.
- Rebuilt with `NEXT_DIST_DIR=.next-live pnpm --filter web build` (Next.js 16.3.3; production build and TypeScript completed successfully).
- Served chat chunk: `.next-live/static/chunks/31e3nx1jbuid0.js`; response contains `/api/v1/chat/runs/` and SHA-256 `e73f5f93045869ce470b2830d1e6f4a80fa05c64238d954c0be7b78186696527`.
- Previous generated `.next-live` directory preserved at `/tmp/artifact-guard-validation/.next-live.pre-browser-refresh`.

## Focused browser result

`chat-concurrency-browser.py` passed against the local production server. All `/api/v1/*` requests were stubbed in Playwright; no model provider or live data was called.

- Started conversations A and B with A's POST response deliberately delayed. B remained selected when A's response arrived; both run IDs polled independently.
- Stopped B while A was still running. Only `run-B` received a cancel request; `run-A` continued polling, completed, and its answer did not appear in B. Reopening A displayed A's persisted answer.
- Reloaded while A was active. The bootstrapped conversation list advertised `activeRun`; a new A poll occurred after reload.
- History loaded with `limit=50`; older history loaded only after clicking, using the returned cursor. A deliberately overlapping boundary message appeared once after merge, and the active answer placeholder remained present.
- Trace endpoint had no request before expansion; expanding the historical answer fetched only that message's trace.
- Browser page errors: none.

## Evidence files

- Script: `/tmp/artifact-guard-validation/chat-concurrency-browser.py`
- Result JSON: `/tmp/artifact-guard-validation/chat-concurrency-browser.json`
- Run log: `/tmp/artifact-guard-validation/chat-concurrency-browser.log`
- Concurrent B view: `/tmp/artifact-guard-validation/chat-b-view-concurrent-runs.png`
- History and placeholder: `/tmp/artifact-guard-validation/chat-history.png`
- Expanded lazy trace: `/tmp/artifact-guard-validation/chat-trace-expanded.png`
- Served JavaScript response used for fingerprint: `/tmp/artifact-guard-validation/served-current-chat.js`

No application source files were changed by this browser proof. The build's generated formatting change to `apps/web/tsconfig.json` was reverted.
