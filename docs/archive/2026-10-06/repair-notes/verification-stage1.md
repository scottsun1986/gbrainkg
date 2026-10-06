# Stage 1 verification (2026-10-06)

- `pnpm --filter web lint`: PASS, exit 0; 127 warnings, 0 errors. Full output: `/tmp/web-lint-current.log`.
- `pnpm --filter web exec tsc --noEmit`: FAIL, exit 1. Full output: `/tmp/web-typecheck-current.log`. Diagnostics:
  - `apps/web/src/components/admin/AdminScreen.tsx:303`: callback accepts `OrgTreeNode`, prop can pass `OrgTreeNode | null`.
  - `apps/web/src/components/admin/OrgPanel.tsx:607`: null assigned to string; `:713`: `{}` not assignable to `ReactNode`; `:725`: `string | undefined` passed where string required; `:753`: unknown not assignable to `ReactNode`.
  - `apps/web/src/components/admin/ReprocessPanel.tsx:285`: `timestamp` missing from inferred `{ level, time, message }` type.
  - `apps/web/src/components/admin/SystemStatusPanel.tsx:612`: `baseUrl` missing from model type; `:615-616`: `testStatus` missing; `:629`: `rag.runtime` possibly undefined.
- `pnpm test:parser`: FAIL, 1 failed / 53 passed / 4 subtests passed. `apps/parser-worker/tests/test_execute.py:48`, `ExecuteContractTests.test_image_without_configured_extractor_fails_without_calling_baidu`: expected error to contain `requires configured OCR`; got `Parser operation failed (RuntimeError)`. Captured log: `apps/parser-worker/src/main.py:1942`.
- `pnpm test:adapter`: PASS, build succeeded and 17/17 contract tests passed.
- `cd apps/parser-worker && python3 -m ruff check .`: PASS.
- `cd apps/parser-worker/src && python3 -m mypy --explicit-package-bases main.py quality.py extractors`: FAIL, `main.py:305-307`, missing annotations on `by_status`, `by_engine`, `by_classification`.
- Also attempted `python3 -m mypy src` from parser-worker root; that invocation fails before checks due to `src/env_config.py` found under both `env_config` and `src.env_config`. The documented pyproject command above gives the actionable 3 annotation errors.
