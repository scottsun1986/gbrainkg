# LLMWiki parser worker

Run locally with `python3 src/main.py` or expose the FastAPI app as
`uvicorn src.main:app --host 0.0.0.0 --port 8000`.

Legacy Word `.doc` files are supported through the userland `antiword`
converter and then indexed as extracted UTF-8 text. Set `ANTIWORD_BIN` when
the converter is installed at a different path.

## PDF routing

PDFs use a cost-aware hybrid route:

1. `pypdf` extracts native text and measures meaningful text coverage per page.
2. A normal text PDF is indexed directly without OCR or GPU work.
3. A scanned or mixed PDF is sent to the configured OCR provider. The current
   cloud adapter is Baidu's asynchronous document parser, which accepts PDF
   input and returns Markdown. It is enabled only with `OCR_PROVIDER=baidu`.
4. If cloud OCR is unavailable, local Docling is used when
   `LOCAL_DOCLING_ENABLED=1`; otherwise a native-text fallback is used when
   one exists and the task fails clearly for a pure scan.

The parser task response exposes `classification`, `page_count`,
`native_page_ratio`, `native_quality`, `engine`, and the OCR task id/page
count. This makes it possible to verify which route was actually used. The
default `OCR_PROVIDER=none` keeps documents on-premises; enabling a cloud OCR
provider is an explicit data egress decision.

Relevant settings:

```text
PDF_PARSE_MODE=hybrid
OCR_PROVIDER=baidu
BAIDU_OCR_API_KEY=...
BAIDU_OCR_SECRET_KEY=...
LOCAL_DOCLING_ENABLED=1
```
