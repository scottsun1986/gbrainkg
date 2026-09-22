from __future__ import annotations

import asyncio
import base64
import html
import ipaddress
import logging
import os
import re
import secrets
import subprocess
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

logger = logging.getLogger('parser-worker')
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Clean proxy environment for httpx/huggingface_hub compatibility
for k in ["ALL_PROXY", "all_proxy"]:
    if os.environ.get(k, "").startswith("socks://"):
        os.environ.pop(k, None)

UPLOAD_ROOT = Path(os.environ.get("UPLOAD_ROOT", "/tmp/llmwiki/parser"))
MAX_FILE_BYTES = 200 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".md", ".txt", ".csv", ".html", ".htm", ".doc", ".docx", ".pdf", ".xls", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg"}
ANTIWORD_BIN = os.environ.get("ANTIWORD_BIN", "antiword")
DOCLING_TIMEOUT_SECONDS = float(os.environ.get("DOCLING_TIMEOUT_SECONDS", "240"))
PDF_PARSE_MODE = os.environ.get("PDF_PARSE_MODE", "hybrid").lower()
OCR_PROVIDER = os.environ.get("OCR_PROVIDER", "none").lower()
OCR_TIMEOUT_SECONDS = float(os.environ.get("OCR_TIMEOUT_SECONDS", "900"))
OCR_POLL_INTERVAL_SECONDS = float(os.environ.get("OCR_POLL_INTERVAL_SECONDS", "5"))
OCR_MAX_FILE_BYTES = int(os.environ.get("OCR_MAX_FILE_BYTES", str(50 * 1024 * 1024)))
BAIDU_OCR_API_KEY = os.environ.get("BAIDU_OCR_API_KEY", "").strip()
BAIDU_OCR_SECRET_KEY = os.environ.get("BAIDU_OCR_SECRET_KEY", "").strip()
BAIDU_OCR_ENDPOINT = os.environ.get(
    "BAIDU_OCR_ENDPOINT", "https://aip.baidubce.com"
).rstrip("/")
LOCAL_DOCLING_ENABLED = os.environ.get("LOCAL_DOCLING_ENABLED", "1").lower() not in {
    "0",
    "false",
    "no",
}
tasks: dict[str, dict[str, Any]] = {}
MAX_TASKS = max(1, int(os.environ.get("PARSER_MAX_TASKS", "5000")))
# Two independent limits:
#  - MAX_TASKS bounds retained entries (finished results keep their markdown until
#    the polling TTL expires), protecting worker memory;
#  - MAX_INFLIGHT_TASKS bounds queued+processing work, protecting parse latency.
# A hung task no longer occupies either forever: the cleanup sweep fails anything
# still queued/processing after PARSER_TASK_STALE_SECONDS.
MAX_INFLIGHT_TASKS = max(
    1, int(os.environ.get("PARSER_MAX_INFLIGHT", str(MAX_TASKS)))
)
# A queued/processing entry that never reaches a terminal state used to occupy
# capacity forever: the sweep below only deleted completed/failed tasks, so a
# hung parse permanently consumed a MAX_TASKS slot until the process restarted.
PARSER_TASK_STALE_SECONDS = max(
    60.0, float(os.environ.get("PARSER_TASK_STALE_SECONDS", "5400"))
)
LEGACY_WORD_MAX_BYTES = int(os.environ.get("LEGACY_WORD_MAX_BYTES", str(60 * 1024 * 1024)))


def _module_available(name: str) -> bool:
    """Capability probe for optional parsers (no import side effects)."""
    try:
        import importlib.util

        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


# Reported by /health so an operator can never be told a capability is active
# while the package that implements it is missing from the image.
DOCLING_INSTALLED = _module_available("docling")
PYMUPDF_INSTALLED = _module_available("fitz")


def reserve_task(task_id: str, filename: str, parser_type: str) -> None:
    # No await between capacity check and reservation: concurrent uploads in
    # this event loop cannot overbook or evict an in-flight task. Completed
    # results retain their normal TTL so API polling can still retrieve them.
    in_flight = 0
    for t in tasks.values():
        if t.get("status") in ("queued", "processing"):
            in_flight += 1
    if in_flight >= MAX_INFLIGHT_TASKS or len(tasks) >= MAX_TASKS:
        raise HTTPException(status_code=503, detail="Parser capacity exhausted", headers={"Retry-After": "5"})
    tasks[task_id] = {"status": "queued", "filename": filename, "parser_type": parser_type, "created_at": time.time()}
_torchvision_compat_lib = None
# Baidu OAuth token cache keyed by the calling credentials. The parser worker
# is shared by multiple app instances which may each supply their own API key,
# so a single global token would leak one tenant's credentials to another.
# Key: (api_key, secret_key); Value: (access_token, expires_at_epoch_seconds).
_baidu_access_tokens: dict[tuple[str, str], tuple[str, float]] = {}

# Docling conversions run inside asyncio.to_thread(); asyncio.wait_for() can
# abandon the await but cannot actually terminate the worker thread, so a
# timed-out conversion keeps consuming CPU/GPU until it finishes on its own.
# Bound the number of concurrent Docling conversions so abandoned/timed-out
# requests cannot pile up threads and model memory without limit.
DOCLING_MAX_CONCURRENCY = max(1, int(os.environ.get("DOCLING_MAX_CONCURRENCY", "2")))
_docling_semaphore = asyncio.Semaphore(DOCLING_MAX_CONCURRENCY)


try:
    from src.quality import _pdf_native_quality, classify_pdf, assess_content_quality
    from src.extractors.vlm_extractor import (
        is_vlm_available,
        enrich_markdown_with_vlm,
        describe_pdf_page_with_vlm,
        describe_image_with_vlm,
    )
except (ImportError, ModuleNotFoundError):
    from quality import _pdf_native_quality, classify_pdf, assess_content_quality
    from extractors.vlm_extractor import (
        is_vlm_available,
        enrich_markdown_with_vlm,
        describe_pdf_page_with_vlm,
        describe_image_with_vlm,
    )


async def periodic_cleanup():
    while True:
        await asyncio.sleep(300)
        current_time = time.time()
        for tid in list(tasks.keys()):
            t_info = tasks[tid]
            status = t_info.get("status")
            age = current_time - t_info.get("created_at", current_time)
            if status in ("completed", "failed"):
                if age > 1800:
                    del tasks[tid]
                continue
            # Stale in-flight task: mark it failed instead of deleting it, so
            # polling clients get a definitive answer *and* the slot returns to
            # the capacity pool.
            if status in ("queued", "processing") and age > PARSER_TASK_STALE_SECONDS:
                logger.error(
                    "Task %s stuck in %s for %.0fs; marking failed to release capacity",
                    tid,
                    status,
                    age,
                )
                t_info["status"] = "failed"
                t_info["error"] = (
                    f"任务在 {status} 状态超过 {int(PARSER_TASK_STALE_SECONDS)} 秒未完成，"
                    "已判定为超时失败（解析进程可能已卡死）"
                )
                t_info["stale_timeout"] = True
                t_info["completed_at"] = current_time

@asynccontextmanager
async def lifespan(app: FastAPI):
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    if LOCAL_DOCLING_ENABLED and not DOCLING_INSTALLED:
        logger.error(
            "LOCAL_DOCLING_ENABLED is on but the docling package is not installed in this "
            "environment: every layout call will fail and fall back to native extraction. "
            "Either install docling in the image or set LOCAL_DOCLING_ENABLED=0."
        )
    if not PYMUPDF_INSTALLED:
        logger.warning(
            "PyMuPDF (fitz) is not installed: per-page VLM enrichment of PDFs is disabled."
        )
    if not os.environ.get("AUTH_TOKEN"):
        logger.warning(
            "AUTH_TOKEN is not configured: parser worker accepts unauthenticated "
            "requests from loopback/internal Docker networks only. Set AUTH_TOKEN "
            "before exposing this service on any external interface."
        )
    cleanup_task = asyncio.create_task(periodic_cleanup())
    yield
    cleanup_task.cancel()

app = FastAPI(title="LLMWiki Parser Worker", version="0.4.0", lifespan=lifespan)

allowed_origins = os.environ.get('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3001').split(',')
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer(auto_error=False)

# Internal Docker bridge range; combined with loopback this is the only
# unauthenticated reachability allowed when AUTH_TOKEN is not configured.
_DOCKER_INTERNAL_NETWORK = ipaddress.ip_network("172.16.0.0/12")


def _client_is_local_trusted(request: Request) -> bool:
    client_host = getattr(request.client, "host", "") if request.client else ""
    if not client_host:
        return False
    try:
        client_ip = ipaddress.ip_address(client_host)
    except ValueError:
        return False
    return client_ip.is_loopback or client_ip in _DOCKER_INTERNAL_NETWORK


def verify_auth(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = os.environ.get("AUTH_TOKEN")
    if token:
        # compare_digest: a plain `!=` on a secret is not constant time, which
        # leaks the token byte by byte to a caller who can measure the response.
        if not credentials or not secrets.compare_digest(str(credentials.credentials), str(token)):
            raise HTTPException(status_code=401, detail="Invalid or missing authentication token")
        return
    # Without AUTH_TOKEN the worker must not be wide open: only loopback and
    # the internal Docker network may call it. Everything else gets 401.
    if not _client_is_local_trusted(request):
        raise HTTPException(
            status_code=401,
            detail="Parser worker authentication is not configured; only loopback/internal network callers are allowed",
        )

class ParseResponse(BaseModel):
    task_id: str
    status: str
    message: str

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "version": app.version,
        "pdf_parse_mode": PDF_PARSE_MODE,
        "ocr_provider": OCR_PROVIDER,
        # Report what the worker can actually do, not only what it was asked to
        # do: the production image does not install Docling, so a bare
        # `local_docling_enabled: true` used to advertise a capability whose
        # every call raised ImportError and fell back to pypdf.
        "local_docling_enabled": LOCAL_DOCLING_ENABLED and DOCLING_INSTALLED,
        "local_docling_configured": LOCAL_DOCLING_ENABLED,
        "docling_installed": DOCLING_INSTALLED,
        # PyMuPDF is only needed to render PDF pages for the (API-based) VLM
        # enrichment; without it that path silently returns an empty string.
        "pymupdf_installed": PYMUPDF_INSTALLED,
        "page_vlm_enrichment_available": PYMUPDF_INSTALLED and is_vlm_available(),
        "task_stale_timeout_seconds": PARSER_TASK_STALE_SECONDS,
        # AnyDoc is intentionally owned by the API's official Node binding;
        # this worker only handles OCR/layout fallbacks.
        "anydoc_available": False,
        "anydoc_owner": "api-node",
    }


@app.get("/metrics")
def metrics():
    total = len(tasks)
    by_status = {}
    by_engine = {}
    by_classification = {}
    for t in tasks.values():
        s = t.get('status', 'unknown')
        by_status[s] = by_status.get(s, 0) + 1
        if t.get("engine"):
            engine = str(t["engine"])
            by_engine[engine] = by_engine.get(engine, 0) + 1
        if t.get("classification"):
            classification = str(t["classification"])
            by_classification[classification] = by_classification.get(classification, 0) + 1
    return {
        'total_tasks': total,
        'by_status': by_status,
        'by_engine': by_engine,
        'by_classification': by_classification,
    }

def decode_text_bytes(content: bytes, filename: str) -> str:
    """Decode plain text with strict UTF-8 first, then Chinese legacy codecs.

    Blind utf-8+replace decoding silently corrupted GBK/GB18030 documents
    (very common for legacy Chinese .txt/.csv uploads) into replacement
    characters. Try strict decodings in order and only fall back to a
    lossy decode when all of them fail.
    """
    for encoding in ("utf-8-sig", "gbk", "gb18030"):
        try:
            text = content.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
        logger.info("Decoded plaintext %s using %s", filename, encoding)
        return text
    logger.warning(
        "No strict decoding succeeded for %s; falling back to utf-8 with replacement characters",
        filename,
    )
    return content.decode("utf-8", errors="replace")


class _HtmlTextExtractor(HTMLParser):
    """HTML -> text that keeps block boundaries, headings and table cells.

    The previous implementation deleted every tag with a regex and replaced it
    with a space, which flattened `<td>` boundaries into nothing (columns ran
    together into meaningless prose), deleted no script/style bodies, and lost
    all heading structure. This walks the markup instead, so a table stays a
    table and sections stay separable.
    """

    _SKIP = {"script", "style", "noscript", "template", "head", "svg", "iframe"}
    _BLOCK = {
        "p", "div", "section", "article", "header", "footer", "main", "aside",
        "ul", "ol", "dl", "dd", "dt", "li", "tr", "table", "thead", "tbody",
        "blockquote", "pre", "hr", "figure", "figcaption", "form", "nav",
    }
    _HEADING = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
    _CELL = {"td", "th"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    @property
    def _skipping(self) -> bool:
        return self._skip_depth > 0

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in self._SKIP:
            self._skip_depth += 1
            return
        if self._skipping:
            return
        if tag in self._CELL:
            self._parts.append(" | ")
        elif tag == "br":
            self._parts.append("\n")
        elif tag in self._HEADING:
            self._parts.append("\n\n" + "#" * self._HEADING[tag] + " ")
        elif tag in self._BLOCK:
            self._parts.append("\n\n")

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in self._SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skipping:
            return
        if tag in self._BLOCK or tag in self._HEADING:
            self._parts.append("\n\n")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skipping:
            return
        text = " ".join(data.split())
        if text:
            self._parts.append(text + " ")

    def get_text(self) -> str:
        raw = "".join(self._parts)
        lines: list[str] = []
        for line in raw.split("\n"):
            stripped = re.sub(r"[ \t]{2,}", " ", line).strip()
            if stripped:
                lines.append(stripped)
            elif lines and lines[-1] != "":
                lines.append("")
        text = "\n".join(lines)
        return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_plaintext(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    text = decode_text_bytes(content, filename)
    if suffix in {".html", ".htm"}:
        parser = _HtmlTextExtractor()
        try:
            parser.feed(text)
            parser.close()
            extracted = parser.get_text()
            if extracted:
                return extracted
        except Exception as exc:  # malformed markup must not fail the upload
            logger.warning("HTML structural extraction failed for %s: %s", filename, exc)
        # Fallback: tag stripping (previous behaviour) rather than returning raw markup.
        text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return text.strip()


def normalize_markdown(markdown: str, filename: str) -> str:
    """Normalize parser output without flattening meaningful document structure.

    Office converters commonly emit a title once as metadata and once as body
    text, and legacy Word emits form-feed page breaks. Removing only repeated
    standalone title lines keeps the original wording while preventing the
    duplicate title from becoming a second high-ranking retrieval passage.
    """
    title = Path(filename).stem.strip()
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n\n").split("\n")
    normalized: list[str] = []
    title_seen = False
    for raw_line in lines:
        line = raw_line.replace("\u200b", "").replace("\ufeff", "").replace("\xa0", " ").rstrip()
        comparable = re.sub(r"^\s*#+\s*", "", line).strip()
        if title and comparable == title:
            if title_seen:
                continue
            title_seen = True
        normalized.append(line)

    result = "\n".join(normalized)
    result = re.sub(r"\n{3,}", "\n\n", result).strip()
    result = re.sub(r"([^\n])\n(第\s*[\d一二三四五六七八九十百千万〇零两]+\s*[章节条款项])", r"\1\n\n\2", result)
    return result

def extract_legacy_word(path: Path) -> str:
    # Validate before handing the file to antiword (an old C converter with a
    # history of memory-safety CVEs): the OLE2 compound-document signature must
    # be present and the size bounded, so an arbitrary uploaded blob cannot be
    # fed to it, and a huge file cannot pin a worker slot.
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise RuntimeError(f"Legacy .doc is unreadable: {exc}") from exc
    if size > LEGACY_WORD_MAX_BYTES:
        raise RuntimeError(
            f"Legacy .doc exceeds the {LEGACY_WORD_MAX_BYTES // (1024 * 1024)}MB conversion limit"
        )
    with path.open("rb") as handle:
        header = handle.read(8)
    if not header.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
        raise RuntimeError(
            "Legacy .doc rejected: the file is not an OLE2 compound document "
            "(a .doc renamed from another format must be converted first)"
        )
    env = os.environ.copy()
    try:
        result = subprocess.run(
            [ANTIWORD_BIN, "-f", str(path)],
            check=False,
            capture_output=True,
            timeout=120,
            env=env,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("Legacy .doc conversion is unavailable: antiword is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Legacy .doc conversion timed out after 120 seconds") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Legacy .doc conversion failed{f': {detail}' if detail else ''}")
    text = result.stdout.decode("utf-8", errors="replace").strip()
    if not text:
        raise RuntimeError("Legacy .doc conversion returned empty text")
    return text

def extract_docx(path: Path) -> str:
    """Extract .docx to Markdown while preserving paragraph/table order."""
    try:
        import docx
        from docx.document import Document as DocxDocument
        from docx.table import Table
        from docx.text.paragraph import Paragraph
        from docx.oxml.table import CT_Tbl
        from docx.oxml.text.paragraph import CT_P

        doc = docx.Document(str(path))
        lines = []

        def iter_blocks(parent: DocxDocument):
            for child in parent.element.body.iterchildren():
                if isinstance(child, CT_P):
                    yield Paragraph(child, parent)
                elif isinstance(child, CT_Tbl):
                    yield Table(child, parent)

        for block in iter_blocks(doc):
            if isinstance(block, Paragraph):
                txt = block.text.strip()
                if not txt:
                    continue
                style_name = (block.style.name if block.style else "").lower()
                heading_match = re.search(r"(?:heading|标题)\s*([1-6])", style_name)
                if heading_match:
                    lines.append(f"{'#' * int(heading_match.group(1))} {txt}")
                else:
                    # Visual pseudo-heading inference:
                    # 1. Bold text or large font size
                    # 2. Section number patterns (e.g. 第一章, 1.1, 一、)
                    runs = [r for r in block.runs if r.text.strip()]
                    all_bold = runs and all(r.bold for r in runs)
                    sizes = [r.font.size.pt for r in runs if r.font and r.font.size]
                    max_pt = max(sizes) if sizes else 0
                    is_short = len(txt) <= 70 and not txt.endswith(("。", "！", "？", "；", ".", "!", "?", ";"))

                    pseudo_level = 0
                    if max_pt >= 16:
                        pseudo_level = 1
                    elif max_pt >= 14:
                        pseudo_level = 2
                    elif all_bold and is_short:
                        num_match = re.match(r"^(\d+(?:\.\d+)+)", txt)
                        if re.match(r"^(第[一二三四五六七八九十0-9]+[章节篇部卷]|Chapter\s*\d+)", txt):
                            pseudo_level = 1
                        elif num_match:
                            pseudo_level = min(6, num_match.group(1).count(".") + 1)
                        elif re.match(r"^([一二三四五六七八九十]+[、.])", txt):
                            pseudo_level = 2
                        else:
                            pseudo_level = 3
                    elif is_short and re.match(r"^(第[一二三四五六七八九十0-9]+[章节篇部卷]|Chapter\s*\d+)", txt):
                        pseudo_level = 1

                    if pseudo_level > 0:
                        lines.append(f"{'#' * pseudo_level} {txt}")
                    else:
                        lines.append(txt)
            else:
                rows = []
                for row in block.rows:
                    cells = [cell.text.strip().replace("\r\n", "<br>").replace("\n", "<br>").replace("|", "\\|") for cell in row.cells]
                    if any(cells):
                        rows.append(cells)
                if rows:
                    width = max(len(row) for row in rows)
                    normalized = [row + [""] * (width - len(row)) for row in rows]
                    # Forward-fill left-most parent column when empty due to merged cells
                    for r_idx in range(1, len(normalized)):
                        if width > 1 and not normalized[r_idx][0] and normalized[r_idx - 1][0]:
                            normalized[r_idx][0] = normalized[r_idx - 1][0]
                    t_lines = ["| " + " | ".join(normalized[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
                    t_lines.extend("| " + " | ".join(row) + " |" for row in normalized[1:])
                    lines.append("\n".join(t_lines))
        return "\n\n".join(lines).strip()
    except Exception as e:
        logger.warning(f"python-docx extraction failed for {path}: {e}")
        return ""

def inspect_pdf_native(path: Path) -> dict[str, Any]:
    """Inspect native PDF text page-by-page without OCR or GPU work."""
    result: dict[str, Any] = {
        "markdown": "",
        "page_count": 0,
        "text_pages": 0,
        "native_chars": 0,
        "native_page_ratio": 0.0,
        "native_quality": "empty",
        "classification": "unknown",
        "page_texts": [],
        "native_page_indexes": [],
    }
    try:
        import pypdf

        reader = pypdf.PdfReader(str(path))
        result["page_count"] = len(reader.pages)
        pages_text = []
        page_texts = []
        for i, page in enumerate(reader.pages):
            txt = (page.extract_text() or "").strip()
            page_texts.append(txt)
            result["native_chars"] += len(re.sub(r"\s+", "", txt))
            if len(re.sub(r"\s+", "", txt)) >= 40:
                result["text_pages"] += 1
            if txt:
                pages_text.append(f"## 第 {i+1} 页\n\n{txt}")
        if pages_text:
            result["markdown"] = f"# {path.stem}\n\n" + "\n\n---\n\n".join(pages_text)
        result["page_texts"] = page_texts
        result["native_page_ratio"] = result["text_pages"] / max(result["page_count"], 1)
        result["native_quality"] = _pdf_native_quality(result["markdown"])
        result["classification"] = classify_pdf(
            int(result["page_count"]),
            int(result["text_pages"]),
            int(result["native_chars"]),
            str(result["native_quality"]),
        )
        # Layout complexity heuristic: detect tables, multi-column whitespace alignment
        complex_signals = 0
        for txt in page_texts:
            lines = [l.strip() for l in txt.split("\n") if l.strip()]
            col_lines = sum(1 for l in lines if re.search(r"\S+\s{4,}\S+\s{4,}\S+", l))
            if col_lines >= 3:
                complex_signals += 1
            if re.search(r"\|\s*[-:]+\s*\|", txt):
                complex_signals += 1
        result["has_complex_layout"] = complex_signals >= max(1, len(page_texts) // 4)
        if result["native_quality"] == "good":
            result["native_page_indexes"] = [
                i
                for i, txt in enumerate(page_texts)
                if len(re.sub(r"\s+", "", txt)) >= 40
            ]
    except Exception as e:
        logger.warning(f"pypdf extraction failed for {path}: {e}")
        result["error"] = str(e)
    return result


def create_pdf_subset(path: Path, page_indexes: list[int]) -> Path:
    """Create a short-lived PDF containing only selected pages."""
    import pypdf

    reader = pypdf.PdfReader(str(path))
    handle = tempfile.NamedTemporaryFile(
        prefix="ocr-pages-", suffix=".pdf", dir=str(UPLOAD_ROOT), delete=False
    )
    subset_path = Path(handle.name)
    try:
        writer = pypdf.PdfWriter()
        for index in page_indexes:
            if 0 <= index < len(reader.pages):
                writer.add_page(reader.pages[index])
        with handle:
            writer.write(handle)
        if not page_indexes:
            raise RuntimeError("No scan pages selected for OCR")
        return subset_path
    except Exception:
        handle.close()
        subset_path.unlink(missing_ok=True)
        raise


def split_ocr_pages(markdown: str) -> list[str]:
    """Split provider Markdown into page bodies when page headings exist."""
    matches = list(re.finditer(r"(?m)^##\s*(?:第\s*)?\d+\s*页\s*$", markdown))
    if not matches:
        return [markdown.strip()] if markdown.strip() else []
    pages = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        body = re.sub(r"\n\s*---\s*$", "", markdown[start:end]).strip()
        if body:
            pages.append(body)
    return pages


def merge_mixed_pdf_markdown(
    title: str,
    page_texts: list[str],
    scan_page_indexes: list[int],
    ocr_markdown: str,
) -> str:
    """Put native and OCR page bodies back into the original page order."""
    ocr_pages = split_ocr_pages(ocr_markdown)
    if not ocr_pages:
        raise RuntimeError("OCR returned no page content for mixed PDF")
    if len(ocr_pages) != len(scan_page_indexes):
        logger.warning(
            "OCR page count mismatch for mixed PDF: expected=%s actual=%s; "
            "assigning provider output to the first scan page",
            len(scan_page_indexes),
            len(ocr_pages),
        )
        ocr_pages = ["\n\n".join(ocr_pages)]

    ocr_by_page = {
        page_index: ocr_pages[position]
        for position, page_index in enumerate(scan_page_indexes[: len(ocr_pages)])
    }
    merged_pages = []
    for page_index in range(max(len(page_texts), max(scan_page_indexes, default=-1) + 1)):
        body = ocr_by_page.get(page_index) or (
            page_texts[page_index] if page_index < len(page_texts) else ""
        )
        if body.strip():
            merged_pages.append(f"## 第 {page_index + 1} 页\n\n{body.strip()}")
    if not merged_pages:
        raise RuntimeError("Mixed PDF merge produced empty Markdown")
    return f"# {title}\n\n" + "\n\n---\n\n".join(merged_pages)


def extract_pdf_native(path: Path) -> str:
    """Extract native PDF text & structure via pypdf in milliseconds."""
    return str(inspect_pdf_native(path).get("markdown", ""))

def extract_excel(path: Path) -> str:
    """Extract .xlsx / .xls sheets to Markdown tables with merged-cell forward fill."""
    try:
        import openpyxl
        wb = openpyxl.load_workbook(str(path), data_only=True)
        sheets_md = []
        for sheetname in wb.sheetnames:
            sheet = wb[sheetname]
            # Forward-fill merged cells across the entire merged range so that
            # downstream retrieval and chunking preserve multi-row/multi-column category context.
            try:
                for merge_range in list(sheet.merged_cells.ranges):
                    min_col, min_row, max_col, max_row = merge_range.bounds
                    top_left_val = sheet.cell(row=min_row, column=min_col).value
                    sheet.unmerge_cells(range_string=str(merge_range))
                    for r in range(min_row, max_row + 1):
                        for c in range(min_col, max_col + 1):
                            sheet.cell(row=r, column=c, value=top_left_val)
            except Exception as merge_err:
                logger.debug(f"Excel unmerge notice for {sheetname}: {merge_err}")

            rows = list(sheet.iter_rows(values_only=True))
            if not rows:
                continue
            # Remove trailing empty rows
            while rows and all(c is None or str(c).strip() == "" for c in rows[-1]):
                rows.pop()
            if not rows:
                continue

            width = max((len(r) for r in rows), default=0)
            if width == 0:
                continue

            raw_header = [
                str(cell if cell is not None else "").replace("|", "\\|").replace("\r\n", " ").replace("\n", " ").strip()
                for cell in rows[0]
            ]
            header = raw_header + [""] * (width - len(raw_header))

            table_lines = [f"### 工作表：{sheetname}\n"]
            table_lines.append("| " + " | ".join(header) + " |")
            table_lines.append("| " + " | ".join(["---"] * width) + " |")
            for row in rows[1:]:
                if all(c is None or str(c).strip() == "" for c in row):
                    continue
                raw_cells = [
                    str(c if c is not None else "").replace("|", "\\|").replace("\r\n", " ").replace("\n", " ").strip()
                    for c in row
                ]
                cells = raw_cells + [""] * (width - len(raw_cells))
                table_lines.append("| " + " | ".join(cells) + " |")
            sheets_md.append("\n".join(table_lines))
        return "\n\n".join(sheets_md)
    except Exception as openpyxl_error:
        # openpyxl intentionally does not read the legacy BIFF .xls format.
        # Keep the lightweight xlrd route optional so production can support
        # .xls without installing the heavyweight layout engine.
        logger.info(f"openpyxl extraction unavailable for {path}: {openpyxl_error}")
        try:
            import xlrd

            try:
                workbook = xlrd.open_workbook(str(path), formatting_info=True)
            except Exception:
                workbook = xlrd.open_workbook(str(path), on_demand=True)

            sheets_md = []
            for sheet in workbook.sheets():
                if sheet.nrows == 0:
                    continue
                grid = [
                    [
                        str(sheet.cell_value(r, c) or "").replace("|", "\\|").replace("\r\n", " ").replace("\n", " ").strip()
                        for c in range(sheet.ncols)
                    ]
                    for r in range(sheet.nrows)
                ]
                if hasattr(sheet, "merged_cells"):
                    for (rlo, rhi, clo, chi) in sheet.merged_cells:
                        val = grid[rlo][clo] if rlo < len(grid) and clo < len(grid[rlo]) else ""
                        for r in range(rlo, min(rhi, len(grid))):
                            for c in range(clo, min(chi, len(grid[r]))):
                                grid[r][c] = val

                while grid and not any(grid[-1]):
                    grid.pop()
                if not grid:
                    continue
                width = max(len(row) for row in grid)
                rows = [row + [""] * (width - len(row)) for row in grid]
                lines = [f"### 工作表：{sheet.name}\n"]
                lines.append("| " + " | ".join(rows[0]) + " |")
                lines.append("| " + " | ".join(["---"] * width) + " |")
                lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
                sheets_md.append("\n".join(lines))
            return "\n\n".join(sheets_md)
        except Exception as xlrd_error:
            logger.warning(f"Legacy Excel extraction failed for {path}: {xlrd_error}")
            return ""


def _pptx_table_markdown(table: Any) -> str:
    rows = []
    for row in table.rows:
        cells = [
            str(cell.text or "").strip().replace("|", "\\|").replace("\n", " ")
            for cell in row.cells
        ]
        if any(cells):
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


def extract_pptx_native(path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    """Extract slide text/tables and retain embedded images for OCR.

    This is the production fallback when local Docling is intentionally
    disabled. Native text is never discarded just because a slide also has a
    picture; pictures are OCR'ed separately when a cloud provider is configured.
    """
    from pptx import Presentation

    presentation = Presentation(str(path))
    slide_blocks: list[str] = []
    image_parts: list[dict[str, Any]] = []

    def _collect_from_shape(shape: Any, slide_num: int, shape_id: Any, parts_acc: list[str]):
        if getattr(shape, "has_text_frame", False):
            text = "\n".join(
                paragraph.text.strip()
                for paragraph in shape.text_frame.paragraphs
                if paragraph.text.strip()
            ).strip()
            if text:
                parts_acc.append(text)
        if getattr(shape, "has_table", False):
            table_md = _pptx_table_markdown(shape.table)
            if table_md:
                parts_acc.append(table_md)
        if getattr(shape, "has_chart", False) or getattr(shape, "shape_type", None) == 3:
            try:
                chart = getattr(shape, "chart", None)
                if chart:
                    title = "图表数据"
                    if getattr(chart, "has_title", False) and getattr(chart, "chart_title", None):
                        title = chart.chart_title.text_frame.text.strip() or "图表数据"
                    plots = getattr(chart, "plots", [])
                    categories = []
                    if plots and hasattr(plots[0], "categories"):
                        categories = [str(c).strip() for c in plots[0].categories]
                    series_list = list(getattr(chart, "series", []))
                    if not categories and series_list:
                        max_len = max((len(getattr(s, "values", [])) for s in series_list), default=0)
                        categories = [str(i) for i in range(1, max_len + 1)]
                    header = ["系列/指标"] + categories
                    c_rows = ["| " + " | ".join(header) + " |", "| " + " | ".join(["---"] * len(header)) + " |"]
                    for s in series_list:
                        s_name = str(getattr(s, "name", "数值")).strip()
                        s_vals = [str(v) if v is not None else "-" for v in getattr(s, "values", [])]
                        row_len = max(len(categories), len(s_vals))
                        if len(s_vals) < row_len:
                            s_vals += ["-"] * (row_len - len(s_vals))
                        c_rows.append("| " + " | ".join([s_name] + s_vals[:row_len]) + " |")
                    if len(c_rows) > 2:
                        parts_acc.append(f"### {title}\n" + "\n".join(c_rows))
            except Exception as chart_err:
                logger.debug("Chart extraction skipped: %s", chart_err)
        if getattr(shape, "shape_type", None) == 13:  # MSO_SHAPE_TYPE.PICTURE
            try:
                image = shape.image
                image_parts.append({
                    "slide": slide_num,
                    "shape": shape_id,
                    "ext": str(image.ext or "png"),
                    "blob": image.blob,
                })
            except Exception as image_error:
                logger.warning("Unable to extract PPTX image on slide %s: %s", slide_num, image_error)
        elif getattr(shape, "shape_type", None) == 6 and hasattr(shape, "shapes"):  # MSO_SHAPE_TYPE.GROUP
            for sub_idx, sub_shape in enumerate(shape.shapes, start=1):
                _collect_from_shape(sub_shape, slide_num, f"{shape_id}_{sub_idx}", parts_acc)

    for slide_number, slide in enumerate(presentation.slides, start=1):
        parts: list[str] = []
        # Spatial 2D sorting: PPTX XML stores shapes in arbitrary z-order/insertion order.
        # Banding by ~4pt (50,000 EMUs) sorts shapes in natural human reading order:
        # slide titles first, top-to-bottom, left-to-right columns.
        sorted_shapes = sorted(
            enumerate(slide.shapes, start=1),
            key=lambda item: (
                round((getattr(item[1], "top", 0) or 0) / 50000),
                getattr(item[1], "left", 0) or 0,
            ),
        )
        for shape_number, shape in sorted_shapes:
            _collect_from_shape(shape, slide_number, shape_number, parts)
        if getattr(slide, "has_notes_slide", False) and getattr(slide.notes_slide, "notes_text_frame", None):
            note_text = slide.notes_slide.notes_text_frame.text.strip()
            if note_text:
                parts.append(f"> **演讲备注**：{note_text}")
        slide_blocks.append("\n\n".join(parts).strip())
    return slide_blocks, image_parts

async def convert_with_docling(path: Path) -> str:
    """Docling deep layout extraction with compatibility guard.

    Cancellation caveat: the conversion body runs via asyncio.to_thread().
    asyncio.wait_for() at the call sites can abandon the await on timeout but
    cannot kill the underlying thread, which keeps running until Docling
    finishes. _docling_semaphore therefore caps the number of concurrent
    conversions so timed-out requests cannot accumulate unbounded threads.
    """
    def _run():
        for k in ["ALL_PROXY", "all_proxy"]:
            if os.environ.get(k, "").startswith("socks://"):
                os.environ.pop(k, None)
        global _torchvision_compat_lib
        import torch
        if _torchvision_compat_lib is None:
            try:
                _torchvision_compat_lib = torch.library.Library("torchvision", "DEF")
            except RuntimeError:
                _torchvision_compat_lib = torch.library.Library("torchvision", "FRAGMENT")
        for operator in ("nms", "qnms"):
            try:
                _torchvision_compat_lib.define(
                    f"{operator}(Tensor boxes, Tensor scores, float iou_threshold) -> Tensor"
                )
            except Exception:
                pass
        from docling.document_converter import DocumentConverter
        converter = DocumentConverter()
        result = converter.convert(str(path))
        return result.document.export_to_markdown()
    async with _docling_semaphore:
        return await asyncio.to_thread(_run)


async def _baidu_token(client: Any, api_key: str, secret_key: str, endpoint: str) -> str:
    now = time.time()
    # Credential-scoped cache: the shared worker serves multiple instances
    # that may pass different Baidu keys, so a cached token must only be
    # reused for the exact (api_key, secret_key) pair it was issued for.
    cache_key = (api_key, secret_key)
    cached = _baidu_access_tokens.get(cache_key)
    if cached and cached[1] > now + 60:
        return cached[0]
    if not api_key or not secret_key:
        raise RuntimeError("Baidu OCR is enabled but API key/secret key is not configured")
    response = await client.post(
        f"{endpoint}/oauth/2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": api_key,
            "client_secret": secret_key,
        },
    )
    response.raise_for_status()
    payload = response.json()
    token = str(payload.get("access_token") or "")
    if not token:
        raise RuntimeError(f"Baidu OCR token request failed: {payload.get('error_description') or payload}")
    expires_in = int(payload.get("expires_in") or 2592000)
    _baidu_access_tokens[cache_key] = (token, now + max(expires_in, 300))
    return token


async def convert_with_baidu_ocr(
    path: Path, ocr_config: dict[str, str]
) -> tuple[str, dict[str, Any]]:
    """Use Baidu's async document parser for scanned/mixed PDFs.

    This is intentionally a PDF-level API call: it preserves page boundaries,
    headings and tables better than rendering every page and calling generic OCR.
    """
    if path.stat().st_size > OCR_MAX_FILE_BYTES:
        raise RuntimeError(
            f"PDF is {path.stat().st_size} bytes; Baidu file_data limit is {OCR_MAX_FILE_BYTES} bytes"
        )
    try:
        import httpx
    except ImportError as exc:
        raise RuntimeError("Baidu OCR requires the httpx dependency") from exc

    timeout = httpx.Timeout(OCR_TIMEOUT_SECONDS, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        endpoint_base = str(ocr_config.get("endpoint") or BAIDU_OCR_ENDPOINT).rstrip("/")
        token = await _baidu_token(
            client,
            str(ocr_config.get("api_key") or BAIDU_OCR_API_KEY),
            str(ocr_config.get("secret_key") or BAIDU_OCR_SECRET_KEY),
            endpoint_base,
        )
        endpoint = f"{endpoint_base}/rest/2.0/brain/online/v2/parser/task"
        raw = await asyncio.to_thread(path.read_bytes)
        response = await client.post(
            endpoint,
            params={"access_token": token},
            data={
                "file_data": base64.b64encode(raw).decode("ascii"),
                "file_name": path.name,
                "language_type": "CHN_ENG",
                "angle_adjust": "true",
                "html_table_format": "false",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
        submitted = response.json()
        if int(submitted.get("error_code", 0) or 0) != 0:
            raise RuntimeError(
                f"Baidu OCR submit failed: {submitted.get('error_msg') or submitted}"
            )
        task_id = str((submitted.get("result") or {}).get("task_id") or "")
        if not task_id:
            raise RuntimeError(f"Baidu OCR did not return task_id: {submitted}")

        query_endpoint = f"{endpoint_base}/rest/2.0/brain/online/v2/parser/task/query"
        deadline = time.monotonic() + OCR_TIMEOUT_SECONDS
        status_payload: dict[str, Any] = {}
        while time.monotonic() < deadline:
            await asyncio.sleep(OCR_POLL_INTERVAL_SECONDS)
            status_response = await client.post(
                query_endpoint,
                params={"access_token": token},
                data={"task_id": task_id},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            status_response.raise_for_status()
            status_payload = status_response.json()
            detail = status_payload.get("result") or {}
            status = str(detail.get("status") or "")
            if status == "success":
                markdown_url = str(detail.get("markdown_url") or "")
                if not markdown_url:
                    raise RuntimeError(f"Baidu OCR returned no markdown URL: {status_payload}")
                markdown_response = await client.get(markdown_url)
                markdown_response.raise_for_status()
                markdown = markdown_response.text.strip()
                if not markdown:
                    raise RuntimeError("Baidu OCR returned empty Markdown")
                return markdown, {
                    "ocr_provider": "baidu",
                    "ocr_task_id": task_id,
                    "ocr_cost_pages": detail.get("cost_page_num"),
                }
            if status == "failed":
                raise RuntimeError(
                    f"Baidu OCR task failed: {detail.get('task_error') or status_payload}"
                )
        raise TimeoutError(f"Baidu OCR task timed out after {OCR_TIMEOUT_SECONDS:g} seconds")


async def convert_image_with_baidu_ocr(
    path: Path, ocr_config: dict[str, str]
) -> tuple[str, dict[str, Any]]:
    """OCR a standalone image or an embedded PPTX image with Baidu.

    The document parser endpoint is the preferred route for PDF because it
    preserves page structure. Images have no page/document container, so use
    Baidu's high-accuracy OCR endpoint and keep the returned line order.
    """
    provider = str(ocr_config.get("provider") or OCR_PROVIDER).lower()
    if provider != "baidu":
        raise RuntimeError("Image OCR requires a Baidu OCR provider or local Docling")
    if path.stat().st_size > OCR_MAX_FILE_BYTES:
        raise RuntimeError(
            f"Image is {path.stat().st_size} bytes; OCR file limit is {OCR_MAX_FILE_BYTES} bytes"
        )
    try:
        import httpx
    except ImportError as exc:
        raise RuntimeError("Baidu OCR requires the httpx dependency") from exc

    timeout = httpx.Timeout(OCR_TIMEOUT_SECONDS, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        endpoint_base = str(ocr_config.get("endpoint") or BAIDU_OCR_ENDPOINT).rstrip("/")
        token = await _baidu_token(
            client,
            str(ocr_config.get("api_key") or BAIDU_OCR_API_KEY),
            str(ocr_config.get("secret_key") or BAIDU_OCR_SECRET_KEY),
            endpoint_base,
        )
        raw = await asyncio.to_thread(path.read_bytes)
        response = await client.post(
            f"{endpoint_base}/rest/2.0/ocr/v1/accurate_basic",
            params={"access_token": token},
            data={
                "image": base64.b64encode(raw).decode("ascii"),
                "detect_direction": "true",
                "paragraph": "true",
                "probability": "true",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
        payload = response.json()
        if int(payload.get("error_code", 0) or 0) != 0:
            raise RuntimeError(
                f"Baidu image OCR failed: {payload.get('error_msg') or payload}"
            )
        words_result = payload.get("words_result") or []
        lines: list[str] = []
        probabilities: list[float] = []
        bbox_count = 0
        for item in words_result:
            words = str(item.get("words") or "").strip() if isinstance(item, dict) else str(item).strip()
            if not words:
                continue
            # Preserve per-line bounding boxes for visual grounding. Emitted as
            # an HTML comment so it is invisible when rendered and stripped by
            # the chunker before indexing, but available to the citation layer.
            bbox_comment = ""
            if isinstance(item, dict):
                location = item.get("location")
                if isinstance(location, dict):
                    try:
                        left = int(location.get("left", 0))
                        top = int(location.get("top", 0))
                        width = int(location.get("width", 0))
                        height = int(location.get("height", 0))
                        bbox_comment = f" <!-- bbox:{left},{top},{width},{height} -->"
                        bbox_count += 1
                    except (TypeError, ValueError):
                        bbox_comment = ""
            lines.append(f"{words}{bbox_comment}")
            if isinstance(item, dict):
                probability = item.get("probability")
                if isinstance(probability, dict):
                    probability = probability.get("average")
                try:
                    if probability is not None:
                        probabilities.append(float(probability))
                except (TypeError, ValueError):
                    pass
        if not lines:
            return "", {
                "ocr_provider": "baidu",
                "ocr_endpoint": "accurate_basic",
                "ocr_words_result_num": 0,
            }
        metadata: dict[str, Any] = {
            "ocr_provider": "baidu",
            "ocr_endpoint": "accurate_basic",
            "ocr_words_result_num": len(lines),
        }
        if probabilities:
            metadata["ocr_average_confidence"] = round(sum(probabilities) / len(probabilities), 4)
        if bbox_count:
            metadata["ocr_bbox_count"] = bbox_count
        return "\n".join(lines), metadata


async def convert_with_cloud_ocr(
    path: Path, ocr_config: dict[str, str]
) -> tuple[str, dict[str, Any]]:
    provider = str(ocr_config.get("provider") or OCR_PROVIDER).lower()
    if provider == "baidu":
        return await convert_with_baidu_ocr(path, ocr_config)
    raise RuntimeError(
        "Scanned PDF requires an OCR provider configured as baidu (or local Docling)"
    )


async def convert_pptx_without_docling(
    path: Path, ocr_config: dict[str, str], doc_title: str | None = None
) -> tuple[str, str, dict[str, Any]]:
    """Build a slide-preserving Markdown representation without Docling.

    Native PPTX text and tables remain lossless; embedded images are sent
    through the configured OCR provider or VLM if available. If no OCR or VLM
    route is available, preserve structured slide sections and informative image
    placeholders so the document remains indexable and reviewable rather than
    failing closed.
    """
    slide_blocks, image_parts = await asyncio.to_thread(extract_pptx_native, path)
    provider = str(ocr_config.get("provider") or OCR_PROVIDER).lower()
    image_by_slide: dict[int, list[str]] = {}
    metadata: dict[str, Any] = {
        "slide_count": len(slide_blocks),
        "embedded_image_count": len(image_parts),
    }
    ocr_extracted_count = 0
    vlm_extracted_count = 0

    stem = Path(doc_title).stem if doc_title else path.stem
    if image_parts:
        if provider == "baidu":
            for position, image in enumerate(image_parts, start=1):
                temp = tempfile.NamedTemporaryFile(
                    prefix=f"pptx-image-{position}-", suffix=f".{image['ext']}", dir=str(UPLOAD_ROOT), delete=False
                )
                image_path = Path(temp.name)
                try:
                    with temp:
                        temp.write(image["blob"])
                    try:
                        image_md, image_metadata = await convert_image_with_baidu_ocr(image_path, ocr_config)
                        if image_md.strip():
                            ocr_extracted_count += 1
                            image_by_slide.setdefault(int(image["slide"]), []).append(
                                f"### 图片区域 {image['shape']}\n\n{image_md.strip()}"
                            )
                            for key, value in image_metadata.items():
                                if key == "ocr_average_confidence" and value is not None:
                                    previous = metadata.get(key)
                                    metadata[key] = round(
                                        (float(previous) * (position - 1) + float(value)) / position, 4
                                    ) if previous is not None else value
                                elif key.startswith("ocr_"):
                                    metadata[key] = metadata.get(key, 0) + value if isinstance(value, (int, float)) else value
                        else:
                            image_by_slide.setdefault(int(image["slide"]), []).append(
                                f"<!-- image: slide-{image['slide']}-picture-{image['shape']} -->\n*(图片区域 {image['shape']} 未识别到有效文字)*"
                            )
                    except Exception as ocr_err:
                        logger.warning("Baidu OCR failed for slide %s image %s: %s", image["slide"], image["shape"], ocr_err)
                        image_by_slide.setdefault(int(image["slide"]), []).append(
                            f"<!-- image: slide-{image['slide']}-picture-{image['shape']} -->\n*(图片区域 {image['shape']} OCR 识别失败: {ocr_err})*"
                        )
                finally:
                    image_path.unlink(missing_ok=True)
        elif is_vlm_available():
            for position, image in enumerate(image_parts, start=1):
                temp = tempfile.NamedTemporaryFile(
                    prefix=f"pptx-vlm-{position}-", suffix=f".{image['ext']}", dir=str(UPLOAD_ROOT), delete=False
                )
                image_path = Path(temp.name)
                try:
                    with temp:
                        temp.write(image["blob"])
                    try:
                        vlm_desc = await describe_image_with_vlm(
                            image_path,
                            context_hint=f"{stem} 幻灯片第 {image['slide']} 页",
                        )
                        if vlm_desc.strip():
                            vlm_extracted_count += 1
                            image_by_slide.setdefault(int(image["slide"]), []).append(
                                f"### 视觉内容解析 (区域 {image['shape']})\n\n{vlm_desc.strip()}"
                            )
                        else:
                            image_by_slide.setdefault(int(image["slide"]), []).append(
                                f"<!-- image: slide-{image['slide']}-picture-{image['shape']} -->\n*(幻灯片图片区域 {image['shape']} 视觉解析为空)*"
                            )
                    except Exception as vlm_err:
                        logger.warning("VLM analysis failed for slide %s image %s: %s", image["slide"], image["shape"], vlm_err)
                        image_by_slide.setdefault(int(image["slide"]), []).append(
                            f"<!-- image: slide-{image['slide']}-picture-{image['shape']} -->\n*(幻灯片包含图片内容)*"
                        )
                finally:
                    image_path.unlink(missing_ok=True)
        else:
            for image in image_parts:
                image_by_slide.setdefault(int(image["slide"]), []).append(
                    f"<!-- image: slide-{image['slide']}-picture-{image['shape']} -->\n*(幻灯片包含图片内容，当前未配置 OCR 或视觉大模型提取)*"
                )

    has_native_text = any(block.strip() for block in slide_blocks)
    sections = [f"# {stem}"]
    for slide_number, block in enumerate(slide_blocks, start=1):
        content = [block] if block else []
        content.extend(image_by_slide.get(slide_number, []))
        if content:
            sections.append(f"## 第 {slide_number} 页\n\n" + "\n\n".join(content))
        else:
            sections.append(f"## 第 {slide_number} 页\n\n*(幻灯片无文字或图片内容)*")

    if not slide_blocks:
        sections.append("## 第 1 页\n\n*(空演示文稿)*")

    markdown = "\n\n---\n\n".join(sections)

    if not has_native_text and not ocr_extracted_count and not vlm_extracted_count:
        metadata["quality_issues"] = ["幻灯片均为图片且未配置 OCR/视觉大模型，已保留页面骨架供复核"]
        metadata["quality_status"] = "needs_review"

    if ocr_extracted_count > 0:
        engine = "python-pptx-native+ocr"
    elif vlm_extracted_count > 0:
        engine = "python-pptx-native+vlm"
    elif image_parts:
        engine = "python-pptx-native"
    else:
        engine = "python-pptx-native"

    return markdown, engine, metadata


async def convert_pdf_with_fallback(
    path: Path,
    classification: str,
    native_md: str,
    ocr_config: dict[str, str],
    page_texts: list[str] | None = None,
    native_page_indexes: list[int] | None = None,
    has_complex_layout: bool = False,
) -> tuple[str, str, dict[str, Any]]:
    """Route PDF to the cheapest suitable engine, then fail open safely."""
    metadata: dict[str, Any] = {}
    if classification == "text":
        if has_complex_layout and LOCAL_DOCLING_ENABLED and PDF_PARSE_MODE in {"auto", "thorough", "deep"}:
            try:
                markdown = await asyncio.wait_for(
                    convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS
                )
                return markdown, "docling-complex-layout", metadata
            except Exception as docling_err:
                logger.warning(f"Docling layout conversion failed on {path.name}, falling back to native: {docling_err}")
                metadata["docling_error"] = str(docling_err)
        if PDF_PARSE_MODE in {"fast", "hybrid", "auto"}:
            return native_md, "pypdf-native", metadata

    if classification in {"scanned", "mixed"} and str(
        ocr_config.get("provider") or OCR_PROVIDER
    ).lower() != "none":
        ocr_path = path
        ocr_subset_path: Path | None = None
        try:
            scan_page_indexes = [
                index
                for index in range(len(page_texts or []))
                if index not in set(native_page_indexes or [])
            ]
            if (
                classification == "mixed"
                and page_texts
                and scan_page_indexes
                and len(scan_page_indexes) < len(page_texts)
            ):
                ocr_subset_path = await asyncio.to_thread(
                    create_pdf_subset, path, scan_page_indexes
                )
                ocr_path = ocr_subset_path
            markdown, ocr_metadata = await convert_with_cloud_ocr(ocr_path, ocr_config)
            if ocr_subset_path:
                markdown = merge_mixed_pdf_markdown(
                    path.stem,
                    page_texts or [],
                    scan_page_indexes,
                    markdown,
                )
                ocr_metadata = {
                    **ocr_metadata,
                    "ocr_original_pages": [index + 1 for index in scan_page_indexes],
                    "ocr_cost_pages": len(scan_page_indexes),
                }
                return markdown, "ocr-baidu-mixed-pages", ocr_metadata
            return markdown, f"ocr-{ocr_config.get('provider') or OCR_PROVIDER}", ocr_metadata
        except Exception as ocr_err:
            logger.warning(f"Cloud OCR on {path.name} failed: {ocr_err}")
            metadata["ocr_error"] = str(ocr_err)
        finally:
            if ocr_subset_path:
                ocr_subset_path.unlink(missing_ok=True)

    if LOCAL_DOCLING_ENABLED:
        try:
            markdown = await asyncio.wait_for(
                convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS
            )
            return markdown, "docling-local", metadata
        except Exception as docling_err:
            logger.warning(f"Local Docling on {path.name} failed/timed out: {docling_err}")
            metadata["docling_error"] = str(docling_err)

    if native_md:
        return native_md, "pypdf-fallback", metadata
    raise RuntimeError(
        f"No parser produced content for {path.name}; classification={classification}, "
        f"OCR_PROVIDER={ocr_config.get('provider') or OCR_PROVIDER}, "
        f"LOCAL_DOCLING_ENABLED={LOCAL_DOCLING_ENABLED}"
    )


async def process_file(
    task_id: str,
    path: Path,
    parser_type: str,
    ocr_config: dict[str, str],
) -> None:
    task = tasks[task_id]
    task["status"] = "processing"
    try:
        suffix = path.suffix.lower()

        # AnyDoc is integrated once through the API's official Node package.
        # This execution service handles OCR and native/complex-layout fallback.
        if suffix in {".md", ".txt", ".csv", ".html", ".htm"}:
            content = await asyncio.to_thread(path.read_bytes)
            task["markdown"] = extract_plaintext(path.name, content)
            task["engine"] = "plaintext"
        elif suffix == ".doc":
            task["conversion"] = "antiword"
            task["markdown"] = await asyncio.to_thread(extract_legacy_word, path)
            task["engine"] = "antiword"
        elif suffix == ".docx":
            md = await asyncio.to_thread(extract_docx, path)
            if md:
                task["markdown"] = md
                task["engine"] = "python-docx"
            else:
                if not LOCAL_DOCLING_ENABLED:
                    raise RuntimeError("DOCX native extraction returned no text and local Docling is disabled")
                md = await convert_with_docling(path)
                task["markdown"] = md
                task["engine"] = "docling"
        elif suffix in {".xlsx", ".xls"}:
            md = await asyncio.to_thread(extract_excel, path)
            if md:
                task["markdown"] = md
                task["engine"] = "openpyxl" if suffix == ".xlsx" else "xlrd"
            else:
                if not LOCAL_DOCLING_ENABLED:
                    raise RuntimeError("Excel native extraction returned no cells and local Docling is disabled")
                md = await convert_with_docling(path)
                task["markdown"] = md
                task["engine"] = "docling"
        elif suffix == ".pptx":
            try:
                md, engine, parser_metadata = await convert_pptx_without_docling(
                    path, ocr_config, doc_title=task.get("filename")
                )
                if md and md.strip():
                    task["markdown"] = md
                    task["engine"] = engine
                    task.update(parser_metadata)
                elif LOCAL_DOCLING_ENABLED:
                    md = await convert_with_docling(path)
                    task["markdown"] = md
                    task["engine"] = "docling-local"
                else:
                    task["markdown"] = md
                    task["engine"] = engine
                    task.update(parser_metadata)
            except Exception as pptx_err:
                if LOCAL_DOCLING_ENABLED:
                    logger.warning("Native PPTX conversion failed for %s: %s, falling back to Docling", path.name, pptx_err)
                    md = await convert_with_docling(path)
                    task["markdown"] = md
                    task["engine"] = "docling-local"
                else:
                    raise
        elif suffix == ".pdf":
            pdf_info = await asyncio.to_thread(inspect_pdf_native, path)
            native_md = str(pdf_info.get("markdown", ""))
            for key in (
                "classification",
                "page_count",
                "text_pages",
                "native_chars",
                "native_page_ratio",
                "native_quality",
            ):
                task[key] = pdf_info.get(key)
            md, engine, parser_metadata = await convert_pdf_with_fallback(
                path,
                str(pdf_info.get("classification") or "unknown"),
                native_md,
                ocr_config,
                [str(text) for text in pdf_info.get("page_texts", [])],
                [int(index) for index in pdf_info.get("native_page_indexes", [])],
                bool(pdf_info.get("has_complex_layout", False)),
            )
            task["markdown"] = md
            task["engine"] = engine
            task.update(parser_metadata)
            if parser_metadata.get("ocr_cost_pages"):
                task["text_pages"] = min(int(task.get("page_count") or 0), int(task.get("text_pages") or 0) + int(parser_metadata["ocr_cost_pages"]))
            elif str(engine).startswith("ocr-") and not parser_metadata.get("ocr_error"):
                task["text_pages"] = int(task.get("page_count") or 0)
        else:
            # Standalone images use local Docling in the test profile and the
            # cloud OCR route in production. No image is silently accepted
            # without text extraction.
            if LOCAL_DOCLING_ENABLED:
                try:
                    md = await convert_with_docling(path)
                    if re.search(r"<!--\s*(?:image|picture|figure)\s*-->", md, flags=re.IGNORECASE):
                        raise RuntimeError("Docling returned an image placeholder; OCR is required for complete image ingestion")
                    task["markdown"] = md
                    task["engine"] = "docling-local"
                except Exception as docling_error:
                    logger.warning("Local Docling image conversion failed for %s: %s", path.name, docling_error)
                    task["docling_error"] = str(docling_error)
                    provider = str(ocr_config.get("provider") or OCR_PROVIDER).lower()
                    if provider == "baidu":
                        md, ocr_metadata = await convert_image_with_baidu_ocr(path, ocr_config)
                        task["markdown"] = f"# {path.stem}\n\n{md}"
                        task["engine"] = "ocr-baidu-image"
                        task.update(ocr_metadata)
                    elif is_vlm_available():
                        vlm_desc = await describe_image_with_vlm(path, context_hint=path.stem)
                        task["markdown"] = f"# {path.stem}\n\n{vlm_desc}"
                        task["engine"] = "vlm-image"
                    else:
                        raise RuntimeError(
                            "Image extraction requires configured OCR, VLM, or local Docling"
                        )
            else:
                provider = str(ocr_config.get("provider") or OCR_PROVIDER).lower()
                if provider == "baidu":
                    md, ocr_metadata = await convert_image_with_baidu_ocr(path, ocr_config)
                    task["markdown"] = f"# {path.stem}\n\n{md}"
                    task["engine"] = "ocr-baidu-image"
                    task.update(ocr_metadata)
                elif is_vlm_available():
                    vlm_desc = await describe_image_with_vlm(path, context_hint=path.stem)
                    task["markdown"] = f"# {path.stem}\n\n{vlm_desc}"
                    task["engine"] = "vlm-image"
                else:
                    raise RuntimeError(
                        "Image extraction requires configured OCR, VLM, or local Docling"
                    )

        if not task.get("markdown", "").strip():
            raise RuntimeError("Extracted Markdown is empty")
        task["markdown"] = normalize_markdown(
            task["markdown"].replace("\x00", "").replace("\u0000", ""),
            str(task.get("filename", "upload.md")),
        )

        # VLM enrichment: describe charts, diagrams, and visual elements
        if is_vlm_available() and task.get("markdown", ""):
            try:
                enriched_md, vlm_meta = await enrich_markdown_with_vlm(
                    task["markdown"],
                    path,
                    context_hint=str(task.get("filename", "")),
                )
                task["markdown"] = enriched_md
                task.update(vlm_meta)
                if vlm_meta.get("vlm_descriptions_added", 0) > 0:
                    logger.info(
                        "VLM enriched %d visual elements in task %s",
                        vlm_meta["vlm_descriptions_added"],
                        task_id,
                    )
            except Exception as vlm_err:
                logger.warning("VLM enrichment failed for task %s: %s", task_id, vlm_err)
                task["vlm_error"] = str(vlm_err)

        task.update(assess_content_quality(task["markdown"], suffix, task))
        # Unification with the API publication gate: a quality rejection is a
        # "hold for review" signal, never a hard parser failure. Only a truly
        # empty extraction (handled above) fails. The API re-assesses quality
        # and persists non-passing documents as needs_review.
        task["status"] = "completed"
        logger.info(
            "Task %s completed successfully via engine=%s classification=%s "
            "ocr_provider=%s native_page_ratio=%s",
            task_id,
            task.get("engine"),
            task.get("classification", "n/a"),
            task.get("ocr_provider", "none"),
            task.get("native_page_ratio", "n/a"),
        )
    except Exception as exc:
        task["status"] = "failed"
        task["error"] = f"Processing failed for {task.get('filename', 'unknown')}: {type(exc).__name__} ({exc})"
        logger.error(f"Error processing file for task {task_id}: {exc}", exc_info=True)
    finally:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass

@app.post("/parse", response_model=ParseResponse)
async def parse_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    parser_type: str = "docling",
    ocr_provider: str | None = Form(None),
    ocr_endpoint: str | None = Form(None),
    ocr_api_key: str | None = Form(None),
    ocr_secret_key: str | None = Form(None),
    _auth: None = Depends(verify_auth),
):
    filename = Path(file.filename or "upload.md").name
    suffix = Path(filename).suffix.lower()
    if not suffix:
        suffix = ".md"
        filename = f"{filename}.md"
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {suffix or 'unknown'}")
        
    if file.size and file.size > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 200 MiB limit")

    if parser_type.lower() == "anydoc":
        raise HTTPException(
            status_code=400,
            detail="AnyDoc parsing is natively handled by the API (Node.js). "
            "The parser worker is reserved for OCR, antiword, and layout fallbacks. "
            "Please route AnyDoc-capable formats through the API first."
        )

    task_id = str(uuid.uuid4())
    path = UPLOAD_ROOT / f"{task_id}{suffix}"
    reserve_task(task_id, filename, parser_type)
    # Stream the upload straight to disk in bounded chunks. Reading the whole
    # body into memory first would let a few concurrent 200 MiB uploads
    # exhaust worker RAM, and the size limit is now enforced while
    # transferring instead of after the full payload already arrived.
    chunk_size = 8 * 1024 * 1024
    received_bytes = 0
    try:
        with path.open("wb") as handle:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                received_bytes += len(chunk)
                if received_bytes > MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail="File exceeds 200 MiB limit")
                await asyncio.to_thread(handle.write, chunk)
    except Exception:
        tasks.pop(task_id, None)
        path.unlink(missing_ok=True)
        raise
    # Credentials are request-scoped and deliberately not copied into tasks;
    # /parse/{task_id} must never expose them.
    ocr_config = {
        "provider": (ocr_provider or OCR_PROVIDER).strip().lower(),
        "endpoint": (ocr_endpoint or BAIDU_OCR_ENDPOINT).strip(),
        "api_key": ocr_api_key or BAIDU_OCR_API_KEY,
        "secret_key": ocr_secret_key or BAIDU_OCR_SECRET_KEY,
    }
    background_tasks.add_task(process_file, task_id, path, parser_type, ocr_config)
    return ParseResponse(task_id=task_id, status="accepted", message=f"File {filename} queued for parsing")

@app.get("/parse/{task_id}")
def parse_status(task_id: str, _auth: None = Depends(verify_auth)):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Parse task not found")
    return {"task_id": task_id, **task}


@app.post("/parse-execute")
async def execute_document(
    file: UploadFile = File(...),
    parser_type: str = "auto",
    ocr_provider: str | None = Form(None),
    ocr_endpoint: str | None = Form(None),
    ocr_api_key: str | None = Form(None),
    ocr_secret_key: str | None = Form(None),
    _auth: None = Depends(verify_auth),
):
    """Execution-only interface; the calling BullMQ job owns durable retries.

    No task ID needs to survive a Python restart. The original upload remains
    in application storage and a failed HTTP execution is safely retried there.
    Legacy async routes remain for compatibility but are not used by ingestion.
    """
    background = BackgroundTasks()
    accepted = await parse_document(
        background, file, parser_type, ocr_provider, ocr_endpoint,
        ocr_api_key, ocr_secret_key, _auth,
    )
    try:
        await background()
        return {"task_id": accepted.task_id, **tasks[accepted.task_id]}
    finally:
        tasks.pop(accepted.task_id, None)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8100)
