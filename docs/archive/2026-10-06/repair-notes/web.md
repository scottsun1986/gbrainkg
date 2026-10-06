# Web report reconciliation and fixes

Scope: apps/web only. Preserved Bearer storage pending root clarification. No production actions, no test execution by development agent.

- M-40: confirmed. Added explicit layout revision to invalidate force-layout effect when rerun clicked.
- M-41: confirmed. Citation cards use mapped citationIndex from server, retaining sparse indices and matching answer source buttons.
- M-42: confirmed. ConfirmModal awaits mutation, disables close/action during pending mutation, catches errors into visible alert, closes only on success. Ref prevents duplicate submission before React commits pending state.
- M-43: confirmed. Assign UUID once when optimistic user/assistant messages are created. Completed polling messages use persisted message ID or stable run ID.
- M-44: confirmed. Document loads abort prior request, use monotonically increasing sequence, ignore stale payloads/errors. Query effect cleanup invalidates pending request on page/filter/KB change and unmount.
- M-45: confirmed. Preserve username case; organization picker allows multiple selections and submits full selected list.
- M-46: confirmed. Require >=1 admin in validation and disabled state; validate admin-assignment response. If assignment fails after KB creation, show explicit actionable partial failure instead of false success. Existing API creator has maintenance access, so retaining KB supports retry through management.
- M-47: confirmed. Await Clipboard writes; report failures. Markdown copied indicator timer is cleared when renewed and on unmount.
- M-48: confirmed. Parse effect owns local URL list; revokes on cleanup. Check cancellation after media inflate before creating URLs so late async completion cannot recreate leaked URLs.
- M-49: confirmed. Office preview reads stream under 32 MiB limit (including chunked response), validates ZIP central directory with 128 MiB expanded/2000-entry cap before parsing. XLSX uses sheetRows=1001; displayed range capped to 1000 rows x100 columns. Keep parsed workbook in ref and reuse on sheet switch, clear on document change/unmount. Oversize PPT falls back to server PDF. Full original file remains downloadable outside Office parsing. Added preview-limits tests for expansion, sparse ranges and stream limit/cancellation.
- M-50: confirmed. LibrariesScreen listens for app-new-kb and app-focus-upload. Removed invalid admin tab write.
- M-51: confirmed. Independent audit and Dream request sequences; latest wins, including initial Dream telemetry fetch versus paging. Read latest audit metadata in external store update subscription. Invalidate requests on unmount.
- M-52: confirmed. Non-OK rename response and network failure now toast.
- M-53: confirmed. Conversation pagination errors now toast; external admin refresh updates initial cursor only until conversation paging has advanced, preserving loaded-page cursor afterward.
- M-54: no report entry exists.
- L-10: confirmed. Presentation shortcuts ignore buttons, links, editable and other form controls; toolbar retains native keyboard actions.
- L-11: confirmed. Escape listener follows latest onClose dependency. Close button also gets native button semantics and accessible label.
- L-12: confirmed. Hide and undo use functional set updates, altering only target conversation.
- L-13: confirmed misleading code. Remove empty auth branch and nonexistent login route assumptions; proxy solely applies security headers; API/AppShell retain actual authentication.
- L-14: potential defense improvement, no reported reachable XSS. Bearer retained as root directed; cookie migration not undertaken.
- GLM P1-3: first verification shows lint zero errors (warnings retained); typed previously explicit-any data with domain models, telemetry contracts and organization callbacks. Deferred mount synchronization on cancellable ticks to preserve SSR hydration while avoiding cascading effect writes; no eslint rule disabled. Final typecheck pending verifier after fixing initial 10 diagnostics.
- GLM P3-1: stable deterministic path fallback IDs for organization snapshots, no Math.random in render/initialization.
- GLM P3-2: removed mutable-store-derived synchronous effect; updates happen in external store event callback and async API response.

Read apps/web/AGENTS.md and installed Next client/server guide before editing. Existing /tmp/lint-web.log used as initial evidence. Verification agent first pass: pnpm --filter web lint passed 0 errors, 127 warnings; typecheck found 10 introduced shape/nullability errors, all addressed. Verifier tasked with final lint/typecheck and web test. Browser regressions worth verifying: failed Confirm keeps dialog/error; two hides + first undo preserves second; sparse citations 2/3 match cards; graph rerun keeps graph populated; rapid document/audit page switching retains latest; multi-org user unchanged save preserves memberships.

## 本轮复验跟进

- 已将开发记录持久保存到本文件，不依赖 `/tmp` 作为最终归档。
- 阶段 2 的 `git diff --check` 指出 `AdminScreen.tsx` 组织 ID 行尾空格，已删除。
- 本次跟进未执行 lint、测试或构建。复验结果由 Luna 提供，并更新主台账。
- 原记录中的“待澄清 Bearer”指初次开发阶段；当前按主任务决定保留 Bearer，不迁移 Cookie。
