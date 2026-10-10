# XLSX worksheet dimension recovery — 2026-10-10

## Finding and scope

The production workbook `电信服务问答对100题.xlsx` declared worksheet dimension `A1`, while its worksheet XML contained 101 rows and 202 cells through row 101. The old openpyxl read-only path trusted the declared dimension and exposed only one row and one column. Local inspection of the original attachment confirmed this baseline: openpyxl 3.1.5 reported `A1:A1`, `max_row=1`, `max_column=1`, and yielded only the header row.

The attachment was used only from `/tmp/telecom-qa100-prod.xlsx` for offline validation. It was not copied into this repository. No production service, production database, or question-answer import endpoint was called; no production reparsing, deployment, or database write occurred.

## Verification

After the parser fix, the application parser read the original workbook into one structured table with 101 rows and header columns `[1, 2]`. The generated markdown contained 7,913 characters. The exact target question `小翼管家APP是做什么的？` and its full source answer were present in the markdown and together in one structured row:

> 小翼管家是电信智能家居管理APP，可统一管理电信智能网关、摄像头、门铃、灯具等全屋智能设备，支持远程控制。

The parser's coverage object reports one sheet source unit processed (`total=1`, `processed=1`). That is a sheet-processing status only; it must not be read as proof of all worksheet rows or cells being covered. Complete worksheet recovery is established here by the parsed table's 101 rows, two columns, and the target row assertions.

The final parser regression suite covers inaccurate small dimensions, formula/cached-value alignment, sparse coordinates and budget rejection before iteration, unselected-sheet behavior, and merge/table bounds after dimensions are reset.

| Check | Result |
| --- | --- |
| `cd apps/parser-worker && PYTHONPATH=src python3 -m pytest tests/test_structured_excel.py -q` | Passed: 18 tests, 9 subtests |
| Offline parse of `/tmp/telecom-qa100-prod.xlsx` via `structured_excel.extract` with temporary artifact/cache roots | Passed: 1 table, 101 rows, columns `[1, 2]`; target question and answer found |
| `cd apps/parser-worker && python3 -m ruff check src/structured_excel.py tests/test_structured_excel.py` | Passed |
| `pnpm run test:parser` | Passed: 114 tests, 20 subtests |
| `pnpm test` | Passed: Turbo 6/6; API 187 passed, 1 suite skipped, 1,642 passed, 5 tests skipped; web 86/86 |

`pnpm test` completed before the final parser-only merge/table-bound guard addition. It was not repeated because the final change remained confined to Python parser code; the parser targeted suite, full parser suite, original workbook parse, and Ruff were rerun after that addition.

## Q&A import behavior

Ordinary spreadsheet upload parses the workbook as structured document content; it does not automatically convert every row into native Q&A records. The `QaPanel` provides a separate explicit import flow: select the question and answer columns (plus optional metadata), validate and preview the mapping, then import. Use that flow when each spreadsheet row should be a direct Q&A item. This parser repair restores complete worksheet reading and does not force automatic Q&A conversion for general uploads.

Command summaries are recorded in [verification.log](./verification.log), and machine-readable results are in [results.json](./results.json).
