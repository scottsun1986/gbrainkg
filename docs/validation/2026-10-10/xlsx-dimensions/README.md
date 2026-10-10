# XLSX worksheet dimension recovery — 2026-10-10

## Finding and scope

The production workbook `电信服务问答对100题.xlsx` declared worksheet dimension `A1`, while its worksheet XML contained 101 rows and 202 cells through row 101. The old openpyxl read-only path trusted the declared dimension and exposed only one row and one column. Local inspection of the original attachment confirmed this baseline: openpyxl 3.1.5 reported `A1:A1`, `max_row=1`, `max_column=1`, and yielded only the header row.

During the initial offline validation, the attachment was used only from `/tmp/telecom-qa100-prod.xlsx` and was not copied into this repository. That local-only phase did not call a production service or write a production database. Production release and parser-only verification are recorded separately below.

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

## Demo deployment verification

After the demo release, read-only service checks on `ubuntu@150.158.137.151` showed the three user units `llmwiki-api`, `llmwiki-web`, and `llmwiki-parser` active. API port 3202 `/ready` returned HTTP 200 with database and Redis `ok`; web port 50003 returned HTTP 200. The parser source SHA-256 and its regression test source SHA-256 matched the locally verified candidate exactly.

The original workbook was sent to a temporary path on the demo host and submitted directly to the authenticated parser `/parse-execute?parser_type=auto` endpoint. It returned HTTP 200 with `status=completed`, engine `openpyxl-stream`, one table, 101 rows, and header columns `[1, 2]`. Its 7,913-character markdown contained the target question and full answer, and one structured row contained both. The parser's temporary upload and the staged workbook were removed after verification. This exercised the parser only; it did not write a business database or import Q&A records.

The parser reported one source unit processed for the one-sheet workbook. As noted above, that unit count is not a row/cell coverage percentage. Machine-readable demo results are included in [results.json](./results.json).

## Production parser verification

After production deployment, read-only checks on `meetings2` showed the system units `llmwiki-api`, `llmwiki-web`, and `llmwiki-parser` active. API port 3000 `/ready` returned HTTP 200 with database and Redis `ok`; the public `knowledge.5gsailor.com:20080` entry redirected once from HTTP to HTTPS and returned HTTP 200. The deployed `structured_excel.py` and its test source SHA-256 values exactly matched the candidate.

Using the existing service token without displaying it, the original workbook was submitted directly to the production parser `/parse-execute?parser_type=auto` endpoint. It returned HTTP 200 with `status=completed`, engine `openpyxl-stream`, one table with 101 rows and columns `[1, 2]`. The 7,913-character markdown contained the target question and full answer, and one structured row contained both. The staged workbook and parser response temporary file were removed. This direct parser check did not write the application database.

This result covers parser execution only. A separate read-only production check used the real szq owner identity: the account was active, had no MFA or forced-password-change/setup requirement, and the authenticated GET for the one active personal knowledge base returned HTTP 200 with `total=0`. An exact document lookup found no original document, and same-owner lookup found no same-named copy. Therefore there was no published/ready document to reprocess and no source to test through chat. No reupload, recovery, retry POST, or chat POST was performed, and the verification wrote no business data. The original production question remains unverified against an indexed document; parser completeness on the supplied file does not establish production retrieval behavior. Production machine-readable health, parser, and source-presence results are in [results.json](./results.json).

The production deployment log also reports Prisma migrations up to date with no pending migrations, while GBrain shared-skills migration `v0.53.0` finished **PARTIAL**: 13 sources require host action, including a `db_only_export_required` item. This is a pre-existing, separate migration follow-up; it is not represented as a full migration success and was not expanded or modified by this parser verification.

Command summaries are recorded in [verification.log](./verification.log), and machine-readable results are in [results.json](./results.json).
