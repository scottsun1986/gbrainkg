from __future__ import annotations
from typing import TYPE_CHECKING

import asyncio
import base64
import html
import ipaddress
import json
import hashlib
import shutil
import socket
from urllib.parse import urlsplit
import logging
import os
import re
import secrets
import subprocess
import signal
import resource
import sys
if TYPE_CHECKING or __package__:
    from .controlled_jobs import FairLimiter, run_process
    from . import artifact_cache, artifact_store, source_contract, structured_excel, image_units, temp_budget
    from .env_config import env_int, env_float
else:
    from controlled_jobs import FairLimiter, run_process
    import artifact_cache
    import artifact_store
    import source_contract
    import structured_excel
    import image_units
    import temp_budget
    from env_config import env_int, env_float
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
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
SUPPORTED_EXTENSIONS = {".md", ".txt", ".csv", ".html", ".htm", ".doc", ".docx", ".pdf", ".xls", ".xlsx", ".pptx", ".ppt", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}
ANTIWORD_BIN = os.environ.get("ANTIWORD_BIN", "antiword")
DOCLING_TIMEOUT_SECONDS = env_float("DOCLING_TIMEOUT_SECONDS", 240)
PDF_PARSE_MODE = os.environ.get("PDF_PARSE_MODE", "hybrid").lower()
OCR_PROVIDER = os.environ.get("OCR_PROVIDER", "none").lower()
OCR_TIMEOUT_SECONDS = env_float("OCR_TIMEOUT_SECONDS", 900)
OCR_POLL_INTERVAL_SECONDS = env_float("OCR_POLL_INTERVAL_SECONDS", 5)
OCR_MAX_FILE_BYTES = env_int("OCR_MAX_FILE_BYTES", 50 * 1024 * 1024)
# Skip icons/decorative images that cannot hold searchable text. Size-only gate
# so the threshold stays corpus-agnostic.
OCR_IMAGE_MIN_SIDE = env_int("OCR_IMAGE_MIN_SIDE", 64)
OCR_IMAGE_MIN_BYTES = env_int("OCR_IMAGE_MIN_BYTES", 2 * 1024)
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
MAX_TASKS = max(1, env_int("PARSER_MAX_TASKS", 5000))
MAX_RETAINED_BYTES = max(
    1, env_int("PARSER_MAX_RETAINED_BYTES", 200 * 1024 * 1024)
)
# Two independent limits:
#  - MAX_TASKS bounds retained entries (finished results keep their markdown until
#    the polling TTL expires), protecting worker memory;
#  - MAX_INFLIGHT_TASKS bounds queued+processing work, protecting parse latency.
# A hung task no longer occupies either forever: the cleanup sweep fails anything
# still queued/processing after PARSER_TASK_STALE_SECONDS.
MAX_INFLIGHT_TASKS = max(
    1, env_int("PARSER_MAX_INFLIGHT", 16)
)
# A queued/processing entry that never reaches a terminal state used to occupy
# capacity forever: the sweep below only deleted completed/failed tasks, so a
# hung parse permanently consumed a MAX_TASKS slot until the process restarted.
PARSER_TASK_STALE_SECONDS = max(
    60.0, env_float("PARSER_TASK_STALE_SECONDS", 5400)
)
LEGACY_WORD_MAX_BYTES = env_int("LEGACY_WORD_MAX_BYTES", 60 * 1024 * 1024)


def safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Parser temporary-file cleanup failed")


def safe_error(error: BaseException) -> str:
    # Never expose provider response bodies or URLs carrying OAuth credentials.
    if isinstance(error, (RuntimeError, ValueError)) and (str(error) == "Image extraction requires configured OCR, VLM, or local Docling" or str(error).startswith(("Image exceeds ", "Workbook exceeds ", "Worksheet exceeds ", "Office package exceeds ", "Structured table exceeds ", "Shared parser temporary ", "Parser temporary disk ", "Legacy PPT conversion requires ", "Parser returned only scaffolding"))):
        return str(error)
    return f"Parser operation failed ({type(error).__name__})"


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
    upload_budget = env_int("PARSER_MAX_TEMP_BYTES", 1024 * 1024 * 1024)
    if (in_flight + 1) * MAX_FILE_BYTES > upload_budget or in_flight >= MAX_INFLIGHT_TASKS or len(tasks) >= MAX_TASKS:
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
# Defaults sized for parallel ingestion: the API keeps 6 ingestion workers in
# flight, so the parser side allows 8 parallel parses (4 Docling) — bounded by
# semaphores, memory-safe on an 8-core host; tune down first if RAM binds.
DOCLING_MAX_CONCURRENCY = max(1, env_int("DOCLING_MAX_CONCURRENCY", 4))
_docling_semaphore = asyncio.Semaphore(DOCLING_MAX_CONCURRENCY)
_parse_limiter = FairLimiter(min(env_int("PARSER_CONCURRENCY", 8), max(1, env_int("PARSER_SHARED_MEMORY_BYTES", 4 * 1024 * 1024 * 1024) // env_int("PARSER_NATIVE_MEMORY_BYTES", 1536 * 1024 * 1024))), env_int("PARSER_QUEUE_LIMIT", 64), env_int("PARSER_PER_INSTANCE_CONCURRENCY", 4))


if TYPE_CHECKING or __package__:
    from .quality import _pdf_native_quality, classify_pdf, assess_content_quality
    from .extractors.vlm_extractor import (
        is_vlm_available,
        enrich_markdown_with_vlm,
        describe_pdf_page_with_vlm,
        describe_image_with_vlm,
    )
else:
    from quality import _pdf_native_quality, classify_pdf, assess_content_quality
    from extractors.vlm_extractor import (
        is_vlm_available,
        enrich_markdown_with_vlm,
        describe_pdf_page_with_vlm,
        describe_image_with_vlm,
    )


def retained_result_bytes(task: dict[str, Any]) -> int:
    if "_retained_bytes" in task:
        return int(task["_retained_bytes"])
    public = {key: value for key, value in task.items() if not key.startswith("_")}
    return sum(len(chunk.encode("utf-8")) for chunk in json.JSONEncoder(ensure_ascii=False).iterencode(public))


def account_retained_result(task_id: str):
    current = tasks.get(task_id)
    if not current or current.get("status") not in ("completed", "failed"):
        return
    current["_retained_bytes"] = retained_result_bytes(current)
    finished = [(info.get("created_at", 0), identifier, retained_result_bytes(info))
        for identifier, info in tasks.items() if info.get("status") in ("completed", "failed")]
    total = sum(size for _, _, size in finished)
    for _, identifier, size in sorted(finished):
        if total <= MAX_RETAINED_BYTES:
            break
        if identifier != task_id:
            tasks.pop(identifier, None)
            total -= size


def public_task_result(task: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in task.items() if not key.startswith("_")}


def in_flight_temp_floor() -> float | None:
    """Oldest creation time among tasks still queued or processing.

    Used as the reclaim floor so a periodic sweep can never delete a file a
    live task may still hold, however long that task has been running.
    """
    floors = [float(info["created_at"]) for info in tasks.values()
              if info.get("status") in ("queued", "processing") and info.get("created_at")]
    return min(floors) if floors else None


def sweep_abandoned_temporaries(reason: str, force: bool = False) -> list[str]:
    """Reclaim temporaries left behind by a hard kill.

    A startup sweep always runs: at boot nothing is in flight, so every stale
    entry belongs to a task that can never complete. The periodic sweep only
    reclaims under budget pressure, so a healthy worker leaves graceful cleanup
    in charge.
    """
    try:
        reclaimed = (temp_budget.reclaim(UPLOAD_ROOT, None if force else in_flight_temp_floor())
                     if force else
                     temp_budget.reclaim_under_pressure(UPLOAD_ROOT, in_flight_temp_floor()))
    except Exception as exc:  # a janitor failure must never stop parsing
        logger.warning("Temporary reclaim skipped (%s): %s", reason, exc)
        return []
    if reclaimed:
        logger.warning(
            "Reclaimed %d abandoned parser temporaries (%s): %s",
            len(reclaimed), reason, ", ".join(reclaimed[:10]),
        )
    return reclaimed


async def periodic_cleanup():
    while True:
        await asyncio.sleep(300)
        current_time = time.time()
        total_bytes = sum(
            retained_result_bytes(t)
            for t in tasks.values()
            if t.get("status") in ("completed", "failed")
        )
        for tid in list(tasks.keys()):
            t_info = tasks[tid]
            status = t_info.get("status")
            age = current_time - t_info.get("created_at", current_time)
            if status in ("completed", "failed"):
                if age > 1800 or total_bytes > MAX_RETAINED_BYTES:
                    total_bytes -= retained_result_bytes(t_info)
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
        sweep_abandoned_temporaries("periodic")

@asynccontextmanager
async def lifespan(app: FastAPI):
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    # A previous process killed by OOM/SIGKILL left its uploaded source, native
    # workspace and spill files behind on a persistent volume. Without this
    # sweep the shared temporary budget is consumed for good and every later
    # upload is rejected with "capacity exhausted" until a human cleans up.
    sweep_abandoned_temporaries("startup", force=True)
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
            "AUTH_TOKEN is not configured: every request is rejected unless "
            "PARSER_ALLOW_UNAUTHENTICATED_LOOPBACK=1 and the caller is loopback. "
            "Internal Docker-network callers are no longer trusted implicitly. "
            "Set AUTH_TOKEN before exposing this service."
        )
    cleanup_task = asyncio.create_task(periodic_cleanup())
    yield
    cleanup_task.cancel()

app = FastAPI(title="LLMWiki Parser Worker", version="0.5.0", lifespan=lifespan)

allowed_origins = os.environ.get('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3001').split(',')
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer(auto_error=False)



def _client_is_local_trusted(request: Request) -> bool:
    client_host = getattr(request.client, "host", "") if request.client else ""
    if not client_host:
        return False
    try:
        client_ip = ipaddress.ip_address(client_host)
    except ValueError:
        return False
    return client_ip.is_loopback


def verify_auth(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = os.environ.get("AUTH_TOKEN")
    if token:
        # compare_digest: a plain `!=` on a secret is not constant time, which
        # leaks the token byte by byte to a caller who can measure the response.
        if not credentials or not secrets.compare_digest(str(credentials.credentials), str(token)):
            raise HTTPException(status_code=401, detail="Invalid or missing authentication token")
        return
    # Unauthenticated loopback is an explicit development option only.
    if os.environ.get("PARSER_ALLOW_UNAUTHENTICATED_LOOPBACK") != "1" or not _client_is_local_trusted(request):
        raise HTTPException(
            status_code=401,
            detail="Parser worker authentication is not configured",
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
        "pdf_regions_available": PYMUPDF_INSTALLED,
        "image_frames_available": _module_available("PIL"),
        "legacy_ppt_available": bool(shutil.which(os.environ.get("SOFFICE_BIN", "soffice"))),
        "structured_tables_available": True,
        "source_units_contract": "source-units-typed-tables-v3",
        "parse_concurrency": _parse_limiter.capacity,
        "page_vlm_enrichment_available": PYMUPDF_INSTALLED and is_vlm_available(),
        "task_stale_timeout_seconds": PARSER_TASK_STALE_SECONDS,
        # AnyDoc is intentionally owned by the API's official Node binding;
        # this worker only handles OCR/layout fallbacks.
        "anydoc_available": False,
        "anydoc_owner": "api-node",
    }


@app.get("/metrics")
def metrics(_auth: None = Depends(verify_auth)):
    total = len(tasks)
    by_status: dict[str, int] = {}
    by_engine: dict[str, int] = {}
    by_classification: dict[str, int] = {}
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
    for encoding in (("utf-16", "utf-8-sig", "gb18030", "gbk") if content.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig", "gb18030", "gbk")):
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
        self._pre_depth = 0

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
        if tag == "pre":
            self._pre_depth += 1
            self._parts.append("\n\n```\n")
        elif tag == "li":
            self._parts.append("\n- ")
        elif tag in self._CELL:
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
        if tag == "pre":
            self._pre_depth = max(0, self._pre_depth - 1)
            self._parts.append("\n```\n\n")
        elif tag in self._BLOCK or tag in self._HEADING:
            self._parts.append("\n\n")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skipping:
            return
        if self._pre_depth:
            self._parts.append(data)
            return
        text = " ".join(data.split())
        if text:
            self._parts.append(text + " ")

    def get_text(self) -> str:
        raw = "".join(self._parts)
        lines: list[str] = []
        fenced = False
        for line in raw.split("\n"):
            if line.strip() == "```":
                fenced = not fenced
                lines.append("```")
                continue
            if fenced:
                lines.append(line.rstrip())
                continue
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
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("antiword_job.py")), ANTIWORD_BIN, str(path), str(MAX_RETAINED_BYTES)], stdout=stdout,
                                     stderr=stderr, env=env, start_new_session=True)
            try:
                child.wait(timeout=120)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise
            stdout.seek(0)
            stderr.seek(0)
            result = subprocess.CompletedProcess(child.args, child.returncode,
                                                 stdout.read(MAX_RETAINED_BYTES), stderr.read(4096))
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

def extract_docx(path: Path, contract: dict[str, Any] | None = None, unit_ids: list[str] | None = None) -> tuple[str, list[dict[str, Any]]]:
    """Extract .docx to Markdown while preserving paragraph/table order.

    Embedded images become position placeholders (``<!-- image: docx-media-N -->``)
    plus a parallel ``image_parts`` list so a later OCR pass can swap the
    placeholder for searchable text without re-parsing the package.
    """
    try:
        import docx
        from docx.document import Document as DocxDocument
        from docx.table import Table
        from docx.text.paragraph import Paragraph
        from docx.oxml.table import CT_Tbl
        from docx.oxml.text.paragraph import CT_P
        from docx.oxml.ns import qn

        doc = docx.Document(str(path))
        lines: list[str] = []
        image_parts: list[dict[str, Any]] = []
        image_counter = 0

        def iter_blocks(parent: DocxDocument):
            def accepted_children(element):
                for child in element.iterchildren():
                    if child.tag == qn("w:ins") or child.tag == qn("w:sdt") or child.tag == qn("w:sdtContent"):
                        yield from accepted_children(child)
                    elif child.tag != qn("w:del"):
                        yield child
            for child in accepted_children(parent.element.body):
                if isinstance(child, CT_P):
                    yield Paragraph(child, parent)
                elif isinstance(child, CT_Tbl):
                    yield Table(child, parent)

        current_anchor = "body"
        current_part = doc.part
        if contract is not None:
            contract.update(source_units=[], native_text_chars=0, generated_text_chars=0, extraction_policy={"revisions": "accepted-view", "comments": "excluded", "headers_footers": "deduplicated", "linked_images": "not_fetched"})

        def collect_images(element: Any, emit: bool = True) -> None:
            nonlocal image_counter
            for image_index, blip in enumerate(element.xpath(".//a:blip"), 1):
                embed = blip.get(qn("r:embed"))
                if not embed:
                    if blip.get(qn("r:link")) and contract is not None:
                        contract["source_units"].append({"id": f"{current_anchor}:linked-image:{image_index}", "kind": "image", "anchor": current_anchor, "status": "failed" if emit else "skipped", "native_text_chars": 0, "generated_text_chars": 0, "error": "external_image_not_fetched", "markdown": ""})
                    continue
                image_counter += 1
                key = f"docx-media-{image_counter}"
                if not emit and (not unit_ids or key not in unit_ids):
                    continue
                try:
                    part = current_part.related_parts[embed]
                    blob = bytes(part.blob or b"")
                    if not blob:
                        continue
                    part_name = str(part.partname)
                    ext = part_name.rsplit(".", 1)[-1].lower() if "." in part_name else "png"
                    content_type = str(getattr(part, "content_type", "") or "")
                    if content_type.startswith("image/"):
                        ext = content_type.split("/", 1)[1].lower() or ext
                    if ext == "jpeg":
                        ext = "jpg"
                except Exception as image_error:
                    logger.warning("Unable to extract DOCX image from %s: %s", path.name, image_error)
                    continue
                image_parts.append({"key": key, "ext": ext, "blob": blob, "anchor": current_anchor})
                lines.append(f"<!-- image: {key} -->")

        for block_index, block in enumerate(iter_blocks(doc), 1):
            current_anchor = f"docx:block:{block_index}"
            selected = not unit_ids or current_anchor in unit_ids
            if not selected:
                if contract is not None:
                    contract["source_units"].append({"id": current_anchor, "kind": "paragraph" if isinstance(block, Paragraph) else "table", "status": "skipped", "native_text_chars": 0, "generated_text_chars": 0})
                collect_images(block._p if isinstance(block, Paragraph) else block._tbl, emit=False)
                continue
            before = len(lines)
            if isinstance(block, Paragraph):
                txt = "".join(node.text or "" for node in block._p.iter(qn("w:t")) if not any(ancestor.tag == qn("w:del") for ancestor in node.iterancestors())).strip()
                if txt:
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
                # Images live in the paragraph XML even when the paragraph has no text.
                collect_images(block._p)
            else:
                rows = []
                for row in block.rows:
                    cells = [" ".join(node.text or "" for node in cell._tc.iter(qn("w:t")) if not any(ancestor.tag == qn("w:del") for ancestor in node.iterancestors())).strip().replace("\r\n", "<br>").replace("\n", "<br>").replace("|", "\\|") for cell in row.cells]
                    if any(cells):
                        rows.append(cells)
                if rows:
                    width = max(len(row) for row in rows)
                    normalized = [row + [""] * (width - len(row)) for row in rows]
                    t_lines = ["| " + " | ".join(normalized[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
                    t_lines.extend("| " + " | ".join(row) + " |" for row in normalized[1:])
                    lines.append("\n".join(t_lines))
                collect_images(block._tbl)
            if contract is not None:
                raw = "\n".join(lines[before:])
                count = source_contract.text_chars(re.sub(r"<!--.*?-->", "", raw, flags=re.S))
                contract["source_units"].append({"id": current_anchor, "kind": "paragraph" if isinstance(block, Paragraph) else "table", "anchor": current_anchor, "status": "processed" if count else "skipped", "native_text_chars": count, "generated_text_chars": 0, "source_kind": "native", "markdown": re.sub(r"<!--.*?-->", "", raw, flags=re.S).strip()})
                contract["native_text_chars"] += count
            if contract is not None:
                for number, obj in enumerate(block._p.xpath(".//w:object") if isinstance(block, Paragraph) else block._tbl.xpath(".//w:object"), 1):
                    contract["source_units"].append({"id": f"{current_anchor}:object:{number}", "kind": "embedded_object", "anchor": current_anchor, "status": "failed", "native_text_chars": 0, "generated_text_chars": 0, "error": "embedded_object_not_extracted", "markdown": ""})
            lines.insert(before, f"<!-- source-unit:{current_anchor} -->")
        # Header/footer parts may be shared across sections; extract each once.
        seen_parts = set()
        for section in doc.sections:
            for label in ("header", "footer", "first_page_header", "first_page_footer", "even_page_header", "even_page_footer"):
                part_container = getattr(section, label)
                if not part_container._has_definition:
                    continue
                current_part = part_container.part
                part_name = str(current_part.partname)
                if part_name in seen_parts:
                    continue
                seen_parts.add(part_name)
                current_anchor = f"docx:{label}:{len(seen_parts)}"
                if unit_ids and current_anchor not in unit_ids:
                    if contract is not None:
                        contract["source_units"].append({"id": current_anchor, "kind": label, "status": "skipped", "native_text_chars": 0, "generated_text_chars": 0})
                    collect_images(part_container._element, emit=False)
                    continue
                text = "\n".join(p.text for p in part_container.paragraphs if p.text.strip())
                if text:
                    lines.extend([f"<!-- source-unit:{current_anchor} -->", text])
                collect_images(part_container._element)
                if contract is not None:
                    count = source_contract.text_chars(text)
                    contract["source_units"].append({"id": current_anchor, "kind": label, "status": "processed" if count else "skipped", "native_text_chars": count, "generated_text_chars": 0, "source_kind": "native", "markdown": text})
                    contract["native_text_chars"] += count
        # Footnotes/endnotes/textboxes are separate XML containers, not Paragraph.text.
        import zipfile
        from xml.etree import ElementTree as ET
        with zipfile.ZipFile(path) as package:
            for item in ("word/footnotes.xml", "word/endnotes.xml"):
                if item not in package.namelist():
                    continue
                xml = ET.fromstring(package.read(item))
                for note in xml:
                    if int(note.attrib.get(qn("w:id"), "0")) <= 0:
                        continue
                    identifier = f"docx:{Path(item).stem}:{note.attrib.get(qn('w:id'))}"
                    if unit_ids and identifier not in unit_ids:
                        continue
                    text = " ".join(t.text or "" for t in note.iter(qn("w:t")))
                    if text.strip():
                        lines.extend([f"<!-- source-unit:{identifier} -->", text])
                        if contract is not None:
                            count = source_contract.text_chars(text)
                            contract["source_units"].append({"id": identifier, "kind": Path(item).stem, "status": "processed", "native_text_chars": count, "generated_text_chars": 0, "source_kind": "native", "markdown": text})
                            contract["native_text_chars"] += count
        return "\n\n".join(lines).strip(), image_parts
    except Exception as e:
        # Record the failure so callers can distinguish "this DOCX is empty"
        # from "extraction crashed". A swallowed ("", []) is indistinguishable
        # from both, which is exactly how image coverage used to disappear.
        logger.warning(f"python-docx extraction failed for {path}: {e}")
        if contract is not None:
            contract["error"] = safe_error(e)
        return "", []

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
        if page_texts:
            result["native_page_indexes"] = [
                i
                for i, txt in enumerate(page_texts)
                if len(re.sub(r"\s+", "", txt)) >= 40 and _pdf_native_quality(txt) == "good"
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
        safe_unlink(subset_path)
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
        raise RuntimeError(
            f"OCR page count mismatch for mixed PDF: expected={len(scan_page_indexes)} actual={len(ocr_pages)}"
        )

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
    """Compatibility projection; ingestion uses the full structured contract."""
    return structured_excel.extract(path, artifact_cache.instance_identity.get())["markdown"]


async def extract_excel_controlled(path: Path, task: dict[str, Any]) -> dict[str, Any]:
    output = path.with_suffix(path.suffix + ".result.json")
    try:
        await run_process([sys.executable, str(Path(__file__).with_name("structured_job.py")),
            str(path), str(output), str(task.get("instanceId", "legacy")),
            json.dumps(task.get("unit_ids") or []), str(task.get("small_table_rows", 200))], 245)
        if output.stat().st_size > 32 * 1024 * 1024:
            raise RuntimeError("Structured parser result exceeds output budget")
        return json.loads(await asyncio.to_thread(output.read_text, encoding="utf-8"))
    finally:
        safe_unlink(output)


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


def extract_pptx_native(path: Path, contract: dict[str, Any] | None = None, unit_ids: list[str] | None = None) -> tuple[list[str], list[dict[str, Any]]]:
    """Extract slide text/tables and retain embedded images for OCR.

    This is the production fallback when local Docling is intentionally
    disabled. Native text is never discarded just because a slide also has a
    picture; pictures are OCR'ed separately when a cloud provider is configured.
    """
    from pptx import Presentation

    presentation = Presentation(str(path))
    slide_blocks: list[str] = []
    image_parts: list[dict[str, Any]] = []
    if contract is not None:
        contract.update(source_units=[], native_text_chars=0, generated_text_chars=0)

    def _collect_from_shape(shape: Any, slide_num: int, shape_id: Any, parts_acc: list[str]):
        before = len(parts_acc)
        identifier = f"slide:{slide_num}:shape:{shape_id}"
        if unit_ids and f"slide:{slide_num}" not in unit_ids and identifier not in unit_ids and f"slide-{slide_num}-picture-{shape_id}" not in unit_ids and not any(u.startswith(identifier + "_") for u in unit_ids):
            if contract is not None:
                contract["source_units"].append({"id": identifier, "kind": "shape", "slide": slide_num, "shape": str(shape_id), "status": "skipped", "native_text_chars": 0, "generated_text_chars": 0})
            return
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
                    "key": f"slide-{slide_num}-picture-{shape_id}",
                    "anchor": identifier,
                    "bbox": [int(shape.left), int(shape.top), int(shape.width), int(shape.height)],
                    "coordinate_space": "group-local-emu" if "_" in str(shape_id) else "slide-emu", "bbox_format": "xywh",
                })
                parts_acc.append(f"<!-- image: slide-{slide_num}-picture-{shape_id} -->")
            except Exception as image_error:
                logger.warning("Unable to extract PPTX image on slide %s: %s", slide_num, image_error)
        elif getattr(shape, "shape_type", None) == 6 and hasattr(shape, "shapes"):  # MSO_SHAPE_TYPE.GROUP
            for sub_idx, sub_shape in enumerate(shape.shapes, start=1):
                _collect_from_shape(sub_shape, slide_num, f"{shape_id}_{sub_idx}", parts_acc)

        if contract is not None and getattr(shape, "shape_type", None) != 6:
            text = "\n".join(parts_acc[before:])
            count = source_contract.text_chars(text)
            uncovered = not count and getattr(shape, "shape_type", None) != 13
            contract["source_units"].append({"id": identifier, "kind": "chart" if getattr(shape, "has_chart", False) else "table" if getattr(shape, "has_table", False) else "shape", "slide": slide_num, "shape": str(shape_id), "bbox": [int(shape.left), int(shape.top), int(shape.width), int(shape.height)], "status": "processed" if count else "failed" if uncovered else "skipped", "error": "object_not_extracted" if uncovered else "", "native_text_chars": count, "generated_text_chars": 0, "source_kind": "native", "markdown": re.sub(r"<!--.*?-->", "", text, flags=re.S).strip()})
            contract["native_text_chars"] += count

    for slide_number, slide in enumerate(presentation.slides, start=1):
        if unit_ids and f"slide:{slide_number}" not in unit_ids and not any(u.startswith(f"slide:{slide_number}:") or u.startswith(f"slide-{slide_number}-picture-") for u in unit_ids):
            slide_blocks.append("")
            if contract is not None:
                contract["source_units"].append({"id": f"slide:{slide_number}", "kind": "slide", "slide": slide_number, "status": "skipped", "native_text_chars": 0, "generated_text_chars": 0})
            continue
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
        if (not unit_ids or f"slide:{slide_number}" in unit_ids or f"slide:{slide_number}:notes" in unit_ids) and getattr(slide, "has_notes_slide", False) and getattr(slide.notes_slide, "notes_text_frame", None):
            note_text = slide.notes_slide.notes_text_frame.text.strip()
            if note_text:
                if contract is not None:
                    count = source_contract.text_chars(note_text)
                    contract["source_units"].append({"id": f"slide:{slide_number}:notes", "kind": "notes", "slide": slide_number, "status": "processed", "native_text_chars": count, "generated_text_chars": 0, "source_kind": "native", "markdown": f"> **演讲备注**：{note_text}"})
                    contract["native_text_chars"] += count
                parts.append(f"> **演讲备注**：{note_text}")
        slide_blocks.append("\n\n".join(parts).strip())
    return slide_blocks, image_parts

async def convert_with_docling(path: Path) -> str:
    """Cancellation reaps the isolated job before returning its shared slot."""
    await asyncio.wait_for(_docling_semaphore.acquire(), timeout=DOCLING_TIMEOUT_SECONDS)
    output = path.with_name(path.name + ".docling.md")
    try:
        await run_process([sys.executable, str(Path(__file__).with_name("docling_job.py")), str(path), str(output)], DOCLING_TIMEOUT_SECONDS)
        if output.stat().st_size > MAX_RETAINED_BYTES:
            raise RuntimeError("Docling result exceeds artifact budget")
        return await asyncio.to_thread(output.read_text, encoding="utf-8")
    finally:
        safe_unlink(output)
        _docling_semaphore.release()


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
        raise RuntimeError("Baidu OCR token request failed")
    expires_in = int(payload.get("expires_in") or 2592000)
    _baidu_access_tokens[cache_key] = (token, now + max(expires_in, 300))
    return token


async def download_ocr_markdown(client: Any, url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("Invalid OCR artifact URL")
    if not any(parsed.hostname == domain or parsed.hostname.endswith("." + domain) for domain in ("bcebos.com", "baidubce.com", "baidu.com")):
        raise RuntimeError("Invalid OCR artifact host")
    addresses = await asyncio.to_thread(socket.getaddrinfo, parsed.hostname, parsed.port or 443)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise RuntimeError("Invalid OCR artifact destination")
    # Redirects must never bypass destination validation.
    async with client.stream("GET", url, follow_redirects=False, timeout=30) as response:
        response.raise_for_status()
        if response.status_code != 200:
            raise RuntimeError("Invalid OCR artifact response")
        chunks = bytearray()
        async for chunk in response.aiter_bytes():
            if len(chunks) + len(chunk) > min(MAX_RETAINED_BYTES, 20 * 1024 * 1024):
                raise RuntimeError("OCR artifact exceeds budget")
            chunks.extend(chunk)
        return chunks.decode("utf-8").strip()


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
                "Baidu OCR submit failed"
            )
        task_id = str((submitted.get("result") or {}).get("task_id") or "")
        if not task_id:
            raise RuntimeError("Baidu OCR did not return task_id")

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
            if status_response.status_code == 429 or status_response.status_code >= 500:
                await asyncio.sleep(min(30, OCR_POLL_INTERVAL_SECONDS * 2))
                continue
            status_response.raise_for_status()
            status_payload = status_response.json()
            detail = status_payload.get("result") or {}
            status = str(detail.get("status") or "")
            if status == "success":
                markdown_url = str(detail.get("markdown_url") or "")
                if not markdown_url:
                    raise RuntimeError("Baidu OCR returned no markdown URL")
                markdown = await download_ocr_markdown(client, markdown_url)
                if not markdown:
                    raise RuntimeError("Baidu OCR returned empty Markdown")
                return markdown, {
                    "ocr_provider": "baidu",
                    "ocr_task_id": task_id,
                    "ocr_cost_pages": detail.get("cost_page_num"),
                }
            if status == "failed":
                raise RuntimeError(
                    "Baidu OCR task failed"
                )
        raise TimeoutError(f"Baidu OCR task timed out after {OCR_TIMEOUT_SECONDS:g} seconds")


async def convert_image_with_baidu_ocr(
    path: Path, ocr_config: dict[str, str]
) -> tuple[str, dict[str, Any]]:
    revision = os.environ.get("OCR_DEPLOYMENT_REVISION", "")
    cache_key = None
    if revision and artifact_cache.instance_identity.get() != "legacy":
        blob = await asyncio.to_thread(path.read_bytes)
        cache_key = artifact_cache.key(blob, {"provider": ocr_config.get("provider"), "endpoint": ocr_config.get("endpoint"), "revision": revision, "credential": hashlib.sha256((str(ocr_config.get("api_key") or BAIDU_OCR_API_KEY) + "\0" + str(ocr_config.get("secret_key") or BAIDU_OCR_SECRET_KEY)).encode()).hexdigest(), "projection": "accurate-image-bbox-v1"})
        cached = await asyncio.to_thread(artifact_cache.read, cache_key)
        if cached:
            return cached[0], {**cached[1], "page_artifact_cache_hit": True}
    result = await _convert_image_with_baidu_ocr(path, ocr_config)
    if cache_key and result[0].strip():
        await asyncio.to_thread(artifact_cache.write, cache_key, result)
    return result


async def _convert_image_with_baidu_ocr(
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


def is_image_ocr_worthy(blob: bytes) -> bool:
    """Size-only gate: skip icons/decorative images that cannot hold text.

    Decoded dimensions decide; the byte floor is only a fallback when Pillow
    is unavailable. Undecodable blobs are refused so OCR quota is not spent
    on junk.
    """
    if not blob:
        return False
    try:
        import io as _io

        from PIL import Image
    except Exception:
        return len(blob) >= OCR_IMAGE_MIN_BYTES
    try:
        with Image.open(_io.BytesIO(blob)) as img:
            width, height = img.size
        return width * height <= image_units.MAX_PIXELS and min(width, height) >= OCR_IMAGE_MIN_SIDE
    except Exception:
        return False


async def ocr_image_parts_into_markdown(
    markdown: str, image_parts: list[dict[str, Any]], ocr_config: dict[str, str],
) -> tuple[str, dict[str, Any]]:
    """Recognise each content hash once, retaining every occurrence/anchor."""
    metadata: dict[str, Any] = {"embedded_image_count": len(image_parts),
        "ocr_image_count": 0, "source_units": [], "assets": [],
        "native_text_chars": 0, "generated_text_chars": 0}
    provider = str(ocr_config.get("provider") or OCR_PROVIDER).lower()
    reusable: dict[str, tuple[str, str, dict[str, Any]]] = {}
    confidences = []
    for position, image in enumerate(image_parts, 1):
        key = str(image.get("key") or f"image-{position}")
        placeholder = f"<!-- image: {key} -->"
        if placeholder not in markdown:
            continue
        blob = bytes(image.get("blob") or b"") if "blob_path" not in image else await asyncio.to_thread(Path(image["blob_path"]).read_bytes)
        digest = hashlib.sha256(blob).hexdigest()
        status, text, error = "failed", "", "no_extractor"
        generated = False
        if not blob:
            error = "empty_image"
        elif not image.get("standalone") and not is_image_ocr_worthy(blob):
            status, error = "skipped", "decorative_size"
        elif digest in reusable:
            status, text, cached_meta = reusable[digest]
            error, generated = cached_meta.get("error", ""), cached_meta.get("generated", False)
            metadata["image_hash_reuses"] = metadata.get("image_hash_reuses", 0) + 1
        elif provider == "baidu" or is_vlm_available():
            ext = str(image.get("ext") or "png").lower().lstrip(".")
            if not re.fullmatch(r"[a-z0-9]{1,8}", ext):
                ext = "png"
            with tempfile.NamedTemporaryFile(prefix="image-unit-", suffix="." + ext,
                                            dir=str(UPLOAD_ROOT), delete=False) as handle:
                temp_budget.write(handle, blob, UPLOAD_ROOT)
                image_path = Path(handle.name)
            try:
                if provider == "baidu":
                    text, ocr_meta = await convert_image_with_baidu_ocr(image_path, ocr_config)
                    if ocr_meta.get("ocr_average_confidence") is not None:
                        confidences.append(float(ocr_meta["ocr_average_confidence"]))
                    metadata["ocr_words_result_num"] = metadata.get("ocr_words_result_num", 0) + int(ocr_meta.get("ocr_words_result_num", 0))
                else:
                    text = await describe_image_with_vlm(image_path, context_hint=str(image.get("anchor") or key))
                    generated = True
                if text.strip():
                    status, error = "processed", ""
                    metadata["ocr_image_count" if not generated else "vlm_image_count"] = metadata.get("ocr_image_count" if not generated else "vlm_image_count", 0) + 1
                else:
                    error = "no_text"
            except Exception as exc:
                error = safe_error(exc)
                logger.warning("Image unit %s failed: %s", key, error)
            finally:
                safe_unlink(image_path)
            reusable[digest] = status, text, {"error": error, "generated": generated}
        image.update(blob=blob, key=key, status=status, text=text, error=error, source_kind="visual" if generated else "ocr" if text else "native")
        asset = source_contract.asset(image, artifact_cache.instance_identity.get())
        metadata["assets"].append(asset)
        image.pop("blob", None)
        count = source_contract.text_chars(text)
        metadata["generated_text_chars" if generated else "native_text_chars"] += count
        location = {k: asset[k] for k in ("page", "slide", "shape", "anchor", "bbox", "coordinate_space", "bbox_format") if k in asset}
        metadata["source_units"].append({"id": key, "kind": "image", "status": status,
            "native_text_chars": 0 if generated else count, "generated_text_chars": count if generated else 0,
            "asset_ids": [asset["id"]], "error": error, "source_kind": image["source_kind"], "markdown": text.strip(), **location})
        if text:
            prefix = "> **[视觉说明 - 模型派生]**\n\n" if generated else "### 图片文字\n\n"
            replacement = placeholder + "\n\n" + prefix + text.strip()
        else:
            note = "装饰性小图，跳过 OCR" if error == "decorative_size" else "图片未提取到正文，待重试"
            replacement = placeholder + "\n*(" + note + ")*"
        markdown = markdown.replace(placeholder, replacement, 1)
    if confidences:
        metadata["ocr_average_confidence"] = round(sum(confidences) / len(confidences), 4)
    if provider == "baidu":
        metadata["ocr_provider"] = provider
    return markdown, metadata


def extract_embedded_image_parts(path: Path) -> list[dict[str, Any]]:
    """Collect embedded images from DOCX / PPTX / PDF for standalone OCR enrichment.

    Raises on enumeration failure: silently returning ``[]`` would tell the API
    the document contains no images, so figure text is never retried and the
    failure is invisible in coverage reporting.
    """
    suffix = path.suffix.lower()
    if suffix == ".docx":
        contract: dict[str, Any] = {}
        _, images = extract_docx(path, contract)
        if contract.get("error"):
            raise RuntimeError(f"DOCX image enumeration failed: {contract['error']}")
        return images
    if suffix == ".pptx":
        _, images = extract_pptx_native(path)
        return images
    if suffix == ".pdf":
        return enumerate_pdf_images(path)
    return []


def enumerate_pdf_images(path: Path) -> list[dict[str, Any]]:
    """Strict PDF image enumeration: a failure is an error, not an empty list.

    `extract_pdf_page_images` stays lenient because the PyMuPDF-less PDF region
    path uses it as a fallback. This wrapper is for callers that must not
    mistake a crash for "this PDF has no images".
    """
    return extract_pdf_page_images(path, strict=True)


async def ocr_embedded_images_fragments(
    path: Path, ocr_config: dict[str, str]
) -> tuple[str, dict[str, Any]]:
    """OCR embedded images and return appendable Markdown fragments.

    Used by the API after AnyDoc text extraction: AnyDoc preserves document
    structure but does not OCR pictures inside Office/PDF files.
    """
    suffix = path.suffix.lower()
    if suffix == ".docx":
        image_parts = (await native_extract("docx", path))["images"]
    elif suffix == ".pptx":
        image_parts = (await native_extract("pptx", path))["images"]
    elif suffix == ".pdf":
        info = await native_extract("pdf_native", path)
        image_parts, _, _ = await native_extract("pdf_regions", path, selected=list(range(info["page_count"])))
    else:
        image_parts = []
    if not image_parts:
        return "", {"embedded_image_count": 0}
    for position, image in enumerate(image_parts, start=1):
        if not image.get("key"):
            image["key"] = f"image-{position}"
    skeleton = "\n\n".join(f"<!-- image: {image['key']} -->" for image in image_parts)
    result, metadata = await ocr_image_parts_into_markdown(skeleton, image_parts, ocr_config)
    return result.strip(), metadata


def extract_pdf_page_images(path: Path, strict: bool = False) -> list[dict[str, Any]]:
    """Collect embedded raster images per PDF page for optional OCR.

    Lenient by default: the PyMuPDF-less region path uses it as a fallback and
    only needs whatever rows were recovered. `strict=True` re-raises, for
    callers that must not mistake a crash for "this PDF has no images".
    """
    results: list[dict[str, Any]] = []
    try:
        import pypdf

        reader = pypdf.PdfReader(str(path))
        for page_index, page in enumerate(reader.pages):
            try:
                page_images = page.images
            except Exception as img_err:
                logger.debug("PDF page %s image enumeration failed: %s", page_index + 1, img_err)
                continue
            for img_index, img in enumerate(page_images, start=1):
                try:
                    blob = bytes(img.data or b"")
                    if not blob:
                        continue
                    name = str(getattr(img, "name", "") or "")
                    ext = name.rsplit(".", 1)[-1].lower() if "." in name else "png"
                    if ext == "jpeg":
                        ext = "jpg"
                    if ext not in {"png", "jpg", "gif", "bmp", "webp", "tif", "tiff"}:
                        ext = "png"
                    results.append({
                        "key": f"p{page_index + 1}-img{img_index}",
                        "page_index": page_index,
                        "ext": ext,
                        "blob": blob,
                    })
                except Exception as one_err:
                    logger.debug(
                        "Skip PDF image page=%s#%s: %s", page_index + 1, img_index, one_err
                    )
    except Exception as e:
        # Lenient on purpose: the PyMuPDF-less PDF region path uses this as a
        # fallback and only needs whatever images were recovered. Callers that
        # must not mistake a crash for "no images" use enumerate_pdf_images.
        logger.warning("PDF image extraction failed for %s: %s", path.name, e)
        if strict:
            raise RuntimeError(f"PDF image extraction failed: {e}") from e
    return results


def insert_pdf_image_placeholders(
    markdown: str, image_parts: list[dict[str, Any]]
) -> str:
    """Attach per-page image placeholders at the end of each ``## 第 N 页`` body."""
    by_page: dict[int, list[str]] = {}
    for image in image_parts:
        page_index = int(image.get("page_index") or 0)
        key = str(image.get("key") or "image")
        by_page.setdefault(page_index, []).append(f"<!-- image: {key} -->")
    if not by_page:
        return markdown

    pattern = re.compile(r"(?m)^(##\s*第\s*(\d+)\s*页\s*)$")
    matches = list(pattern.finditer(markdown))
    if not matches:
        extras = "\n\n".join(
            placeholder for placeholders in by_page.values() for placeholder in placeholders
        )
        return f"{markdown.rstrip()}\n\n{extras}"

    pieces: list[str] = []
    last = 0
    for index, match in enumerate(matches):
        pieces.append(markdown[last:match.start()])
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        body = markdown[start:end]
        page_number = int(match.group(2))
        placeholders = by_page.get(page_number - 1, [])
        if placeholders:
            body = body.rstrip() + "\n\n" + "\n\n".join(placeholders) + "\n\n"
        pieces.append(match.group(1) + body)
        last = end
    pieces.append(markdown[last:])
    return "".join(pieces)


async def enrich_pdf_figures_with_ocr(
    markdown: str,
    path: Path,
    ocr_config: dict[str, str],
    metadata: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    """OCR large figures on native-text PDF pages and splice text into the page."""
    image_parts = await asyncio.to_thread(extract_pdf_page_images, path)
    if not image_parts:
        return markdown, metadata
    placeholder_md = insert_pdf_image_placeholders(markdown, image_parts)
    enriched, ocr_metadata = await ocr_image_parts_into_markdown(
        placeholder_md, image_parts, ocr_config
    )
    merged = {**metadata, **ocr_metadata}
    return enriched, merged


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
    path: Path, ocr_config: dict[str, str], doc_title: str | None = None,
    unit_ids: list[str] | None = None,
) -> tuple[str, str, dict[str, Any]]:
    parsed = await native_extract("pptx", path, unit_ids=unit_ids)
    contract, blocks, images = parsed["contract"], parsed["blocks"], parsed["images"]
    title = Path(doc_title).stem if doc_title else path.stem
    sections = [f"# {title}"]
    for number, block in enumerate(blocks, 1):
        if unit_ids and not block:
            continue
        sections.append(f"## 第 {number} 页\n\n{block}")
    markdown, image_meta = await ocr_image_parts_into_markdown("\n\n".join(sections), images, ocr_config)
    contract["native_text_chars"] += image_meta.pop("native_text_chars", 0)
    contract["generated_text_chars"] += image_meta.pop("generated_text_chars", 0)
    contract["source_units"].extend(image_meta.pop("source_units", []))
    contract.update(image_meta, slide_count=len(blocks))
    source_contract.summarize(contract)
    engine = "python-pptx-native+ocr" if contract.get("ocr_image_count") else "python-pptx-native+vlm" if contract.get("vlm_image_count") else "python-pptx-native"
    contract["extraction_policy"] = {"hidden_slides": "included", "notes": "included", "unparsed_objects": "reported"}
    return markdown, engine, contract


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
                logger.warning(f"Docling layout conversion failed on {path.name}, falling back to native: {safe_error(docling_err)}")
                metadata["docling_error"] = safe_error(docling_err)
        if PDF_PARSE_MODE in {"fast", "hybrid", "auto"}:
            # Native-text pages may still carry figures/charts whose labels are
            # only available through image OCR. Scan pages are handled by the
            # cloud document parser below and must not be double-billed.
            enriched_md, metadata = await enrich_pdf_figures_with_ocr(
                native_md, path, ocr_config, metadata
            )
            engine = "pypdf-native+ocr" if metadata.get("ocr_image_count") else "pypdf-native"
            return enriched_md, engine, metadata

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
            logger.warning(f"Cloud OCR on {path.name} failed: {safe_error(ocr_err)}")
            metadata["ocr_error"] = safe_error(ocr_err)
        finally:
            if ocr_subset_path:
                safe_unlink(ocr_subset_path)

    if LOCAL_DOCLING_ENABLED:
        try:
            markdown = await asyncio.wait_for(
                convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS
            )
            return markdown, "docling-local", metadata
        except Exception as docling_err:
            logger.warning(f"Local Docling on {path.name} failed/timed out: {safe_error(docling_err)}")
            metadata["docling_error"] = safe_error(docling_err)

    if native_md:
        enriched_md, metadata = await enrich_pdf_figures_with_ocr(
            native_md, path, ocr_config, metadata
        )
        engine = "pypdf-fallback+ocr" if metadata.get("ocr_image_count") else "pypdf-fallback"
        return enriched_md, engine, metadata
    raise RuntimeError(
        f"No parser produced content for {path.name}; classification={classification}, "
        f"OCR_PROVIDER={ocr_config.get('provider') or OCR_PROVIDER}, "
        f"LOCAL_DOCLING_ENABLED={LOCAL_DOCLING_ENABLED}"
    )


async def convert_legacy_ppt(path: Path, config: dict[str, str], task: dict[str, Any]):
    if path.stat().st_size > LEGACY_WORD_MAX_BYTES:
        raise ValueError("Legacy presentation exceeds conversion budget")
    with path.open("rb") as handle:
        if handle.read(8) != bytes.fromhex("D0CF11E0A1B11AE1"):
            raise ValueError("Legacy presentation is not an OLE2 package")
    binary = shutil.which(os.environ.get("SOFFICE_BIN", "soffice"))
    if not binary:
        raise RuntimeError("Legacy PPT conversion requires the local soffice executable")
    with tempfile.TemporaryDirectory(prefix="legacy-ppt-", dir=str(UPLOAD_ROOT)) as work:
        await run_process([sys.executable, str(Path(__file__).with_name("office_job.py")),
            str(path), work, binary], 120)
        converted = Path(work) / (path.stem + ".pptx")
        structured_excel.check_package(converted)
        markdown, engine, metadata = await convert_pptx_without_docling(converted, config,
            str(task.get("filename", "")), task.get("unit_ids"))
        metadata.update(conversion="isolated-soffice", conversion_policy={"macros": "disabled", "external_links": "not_refreshed"})
        return markdown, engine, metadata


def inspect_pdf_regions(path: Path, selected: set[int] | None = None):
    """Raster occurrences plus native text region bounds in original page units."""
    images: list[dict[str, Any]] = []
    regions: list[dict[str, Any]] = []
    try:
        import fitz
    except ImportError:
        images = extract_pdf_page_images(path)
        if selected is not None:
            images = [i for i in images if i["page_index"] in selected]
        for image in images:
            image["anchor"] = f'page:{image["page_index"] + 1}'
        return images, regions, "page-only"
    with fitz.open(path) as document:
        if len(document) > env_int("PARSER_PDF_MAX_PAGES", 2000):
            raise ValueError("PDF exceeds page budget")
        for index, page in enumerate(document):
            if selected is not None and index not in selected:
                continue
            for number, block in enumerate(page.get_text("blocks"), 1):
                if len(block) < 7 or block[6] != 0:
                    continue
                text = str(block[4]).strip()
                if text:
                    regions.append({"id": f"page:{index + 1}:region:{number}", "kind": "text_region", "page": index + 1,
                        "bbox": [block[0], block[1], block[2] - block[0], block[3] - block[1]], "coordinate_space": "pdf-point", "bbox_format": "xywh", "status": "processed", "native_text_chars": source_contract.text_chars(text),
                        "generated_text_chars": 0, "source_kind": "native", "markdown": text})
            for number, image_info in enumerate(page.get_images(full=True), 1):
                xref = image_info[0]
                width, height = image_info[2:4]
                if width * height > image_units.MAX_PIXELS:
                    regions.append({"id": f"p{index + 1}-img{number}", "kind": "image", "page": index + 1,
                        "status": "failed", "native_text_chars": 0, "generated_text_chars": 0, "error": "pixel_budget"})
                    continue
                extracted = document.extract_image(xref)
                boxes = page.get_image_rects(xref)
                for occurrence, box in enumerate(boxes or [None], 1):
                    image = {"key": f"p{index + 1}-img{number}-{occurrence}", "page_index": index,
                        "ext": extracted["ext"], "blob": extracted["image"], "anchor": f"page:{index + 1}"}
                    if box is not None:
                        image["bbox"] = [box.x0, box.y0, box.width, box.height]
                        image.update(coordinate_space="pdf-point", bbox_format="xywh")
                    images.append(image)
            # Vector diagrams have no raster resource. Keep a bounded rendered
            # source and mark it separately so OCR/VLM interpretation is visible.
            if len(page.get_drawings()) > 5:
                scale = min(2.0, (image_units.WORKING_PIXELS / max(1, page.rect.width * page.rect.height)) ** .5)
                pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                images.append({"key": f"page:{index + 1}:vector-layout", "page_index": index,
                    "ext": "png", "blob": pixmap.tobytes("png"), "anchor": f"page:{index + 1}",
                    "bbox": [page.rect.x0, page.rect.y0, page.rect.width, page.rect.height], "coordinate_space": "pdf-point", "bbox_format": "xywh", "vector_layout": True})
    return images, regions, "regions"


async def convert_pdf_structured(path: Path, info: dict[str, Any], config: dict[str, str], requested=None):
    texts = info.get("page_texts", [])
    if len(texts) > env_int("PARSER_PDF_MAX_PAGES", 2000):
        raise ValueError("PDF exceeds page budget")
    requested = set(requested or [])
    selected = {i for i in range(len(texts)) if not requested or f"page:{i + 1}" in requested
        or any(u.startswith(f"page:{i + 1}:") or u.startswith(f"p{i + 1}-img") for u in requested)}
    images, regions, precision = await native_extract("pdf_regions", path, selected=list(selected))
    units, sections, assets = [], [], []
    native_total = generated_total = 0
    image_metadata: dict[str, Any] = {"embedded_image_count": 0, "ocr_image_count": 0}
    image_confidence_total = 0.0
    image_confidence_count = 0
    native_pages = set(info.get("native_page_indexes", []))
    for index, native in enumerate(texts):
        identifier = f"page:{index + 1}"
        if index not in selected:
            units.append({"id": identifier, "kind": "page", "page": index + 1, "status": "skipped",
                "native_text_chars": 0, "generated_text_chars": 0, "error": "not_selected"})
            continue
        body, engine, error = native, "native", ""
        complex_layout = bool(info.get("has_complex_layout")) and PDF_PARSE_MODE in {"auto", "thorough", "deep"} and LOCAL_DOCLING_ENABLED and DOCLING_INSTALLED
        if index not in native_pages or complex_layout:
            subset = Path((await native_extract("pdf_subset", path, pages=[index]))["path"])
            try:
                if complex_layout:
                    body = await convert_with_docling(subset)
                    engine = "docling"
                elif str(config.get("provider") or OCR_PROVIDER).lower() == "baidu":
                    body, _ = await convert_with_cloud_ocr(subset, config)
                    engine = "ocr"
                elif LOCAL_DOCLING_ENABLED and DOCLING_INSTALLED:
                    body = await convert_with_docling(subset)
                    engine = "docling"
            except Exception as exc:
                error = safe_error(exc)
                body = native
            finally:
                safe_unlink(subset)
        count = source_contract.text_chars(source_contract.body_text(body))
        page_unit = {"id": identifier, "kind": "page", "page": index + 1,
            "status": "processed" if count else "failed", "native_text_chars": count,
            "generated_text_chars": 0, "source_kind": engine, "markdown": source_contract.body_text(body), "error": error}
        units.append(page_unit)
        native_total += count
        page_images = [image for image in images if image["page_index"] == index]
        if requested and identifier not in requested:
            page_images = [image for image in page_images if image["key"] in requested]
        image_metadata["embedded_image_count"] += len(page_images)
        if index not in native_pages and engine in {"ocr", "docling"} and count:
            # Cloud/layout already saw these page pictures: retain the asset
            # without billing each scanned-page raster a second time.
            for image in page_images:
                image.update(status="processed", source_kind=engine)
                saved = source_contract.asset(image, artifact_cache.instance_identity.get())
                assets.append(saved)
                units.append({"id": image["key"], "kind": "image", "page": index + 1,
                    "anchor": identifier, "status": "processed", "asset_ids": [saved["id"]],
                    "native_text_chars": 0, "generated_text_chars": 0, "source_kind": engine,
                    "markdown": "", "reference_only": True, "error": "covered_by_page_parser", **({"bbox": image["bbox"]} if "bbox" in image else {})})
        else:
            skeleton = "\n\n".join(f'<!-- image: {image["key"]} -->' for image in page_images)
            extra, meta = await ocr_image_parts_into_markdown(skeleton, page_images, config)
            body = body + "\n\n" + extra if extra else body
            units.extend(meta["source_units"])
            assets.extend(meta["assets"])
            native_total += meta["native_text_chars"]
            generated_total += meta["generated_text_chars"]
            for key in ("ocr_image_count", "vlm_image_count", "image_hash_reuses", "ocr_words_result_num"):
                if key in meta:
                    image_metadata[key] = image_metadata.get(key, 0) + meta[key]
            if "ocr_provider" in meta:
                image_metadata["ocr_provider"] = meta["ocr_provider"]
            if meta.get("ocr_average_confidence") is not None:
                count = int(meta.get("ocr_image_count", 0))
                image_confidence_total += float(meta["ocr_average_confidence"]) * count
                image_confidence_count += count
        if body.strip():
            sections.append(f"## 第 {index + 1} 页\n\n{body.strip()}")
    # Native region bounds are evidence references. The page owns the text and
    # statistics, preventing duplicate counts/projections during unit retries.
    for region in regions:
        region["reference_only"] = True
        region["markdown"] = ""
    units.extend(regions)
    metadata = {"source_units": units, "assets": assets, "native_text_chars": native_total,
        "generated_text_chars": generated_total, "source_precision": precision,
        "ocr_original_pages": [i + 1 for i in selected if i not in native_pages],
        "ocr_cost_pages": sum(i not in native_pages for i in selected), **image_metadata}
    if image_confidence_count:
        metadata["ocr_average_confidence"] = round(image_confidence_total / image_confidence_count, 4)
    source_contract.summarize(metadata)
    return "\n\n".join(sections), "pdf-structured", metadata


async def native_extract(operation: str, path: Path, **arguments):
    directory = Path(tempfile.mkdtemp(prefix=path.stem + "-native-", dir=str(UPLOAD_ROOT)))
    try:
        await run_process([sys.executable, str(Path(__file__).with_name("native_job.py")),
            operation, str(path), str(directory), json.dumps(arguments)], 245)
        result_path = directory / "result.json"
        if result_path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("Native parser result exceeds output budget")
        result = json.loads(await asyncio.to_thread(result_path.read_text, encoding="utf-8"))
        def restore(item):
            if isinstance(item, dict):
                if "blob_path" in item:
                    name = item["blob_path"]
                    if not isinstance(name, str) or not re.fullmatch(r"blob-\d+\.bin", name):
                        raise ValueError("Invalid native blob reference")
                    item["blob_path"] = str(directory / name)
                return {key: restore(value) for key, value in item.items()}
            if isinstance(item, list):
                return [restore(value) for value in item]
            return item
        return restore(result)
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise


def cleanup_native(path: Path):
    for directory in UPLOAD_ROOT.glob(path.stem + "-native-*"):
        shutil.rmtree(directory, ignore_errors=True)


async def process_file(task_id: str, path: Path, parser_type: str, ocr_config: dict[str, str]) -> None:
    identity = str(tasks.get(task_id, {}).get("instanceId", "legacy"))
    identity_token = artifact_cache.instance_identity.set(identity)
    inline_token = source_contract.inline_asset_bytes.set(0)
    assets_token = source_contract.asset_artifacts.set({})
    try:
        async with _parse_limiter.slot(identity):
            await asyncio.wait_for(_process_file(task_id, path, parser_type, ocr_config), timeout=PARSER_TASK_STALE_SECONDS)
    except (Exception, asyncio.CancelledError) as error:
        if task_id in tasks:
            tasks[task_id].update(status="failed", error=safe_error(error), finished_at=time.time())
            account_retained_result(task_id)
        safe_unlink(path)
        cleanup_native(path)
        if isinstance(error, asyncio.CancelledError):
            raise
    finally:
        artifact_cache.instance_identity.reset(identity_token)
        source_contract.inline_asset_bytes.reset(inline_token)
        source_contract.asset_artifacts.reset(assets_token)


async def _process_file(
    task_id: str,
    path: Path,
    parser_type: str,
    ocr_config: dict[str, str],
) -> None:
    task = tasks[task_id]
    task["status"] = "processing"
    task["parser_contract"] = "source-units-typed-tables-v3"
    try:
        suffix = path.suffix.lower()
        await asyncio.to_thread(structured_excel.check_package, path)
        unit_ids = task.get("unit_ids") or []

        # AnyDoc is integrated once through the API's official Node package.
        # This execution service handles OCR and native/complex-layout fallback.
        if suffix in {".md", ".txt", ".csv", ".html", ".htm"}:
            parsed = await native_extract("plaintext", path)
            task["markdown"] = parsed["markdown"]
            task["engine"] = "plaintext"
            task["native_text_chars"] = source_contract.text_chars(task["markdown"])
            task["generated_text_chars"] = 0
            task["source_units"] = [{"id": "text:body", "kind": "text", "status": "processed" if task["native_text_chars"] else "failed", "native_text_chars": task["native_text_chars"], "generated_text_chars": 0, "source_kind": "native", "markdown": task["markdown"]}]
        elif suffix == ".doc":
            task["conversion"] = "antiword"
            task["markdown"] = await asyncio.to_thread(extract_legacy_word, path)
            task["engine"] = "antiword"
            task.update(native_text_chars=source_contract.text_chars(task["markdown"]), generated_text_chars=0, source_units=[source_contract.unit("doc:body", "text", task["markdown"], markdown=task["markdown"])], extraction_policy={"layout": "text_only", "images": "not_covered"})
        elif suffix == ".docx":
            parsed = await native_extract("docx", path, unit_ids=unit_ids)
            contract, md, docx_images = parsed["contract"], parsed["markdown"], parsed["images"]
            if unit_ids and any(u.startswith("docx-media-") for u in unit_ids):
                docx_images = [image for image in docx_images if image["key"] in unit_ids or image.get("anchor") in unit_ids]
            task.update(contract)
            if md or docx_images:
                if docx_images:
                    md, ocr_metadata = await ocr_image_parts_into_markdown(
                        md, docx_images, ocr_config
                    )
                    task["native_text_chars"] += ocr_metadata.pop("native_text_chars", 0)
                    task["generated_text_chars"] += ocr_metadata.pop("generated_text_chars", 0)
                    task["source_units"].extend(ocr_metadata.pop("source_units", []))
                    task.update(ocr_metadata)
                if md.strip():
                    task["markdown"] = md
                    task["engine"] = (
                        "python-docx+ocr" if task.get("ocr_image_count") else "python-docx"
                    )
                else:
                    if not LOCAL_DOCLING_ENABLED:
                        raise RuntimeError(
                            "DOCX extraction returned no indexable content and local Docling is disabled"
                        )
                    md = await asyncio.wait_for(convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS)
                    task["markdown"] = md
                    task["engine"] = "docling"
            else:
                if not LOCAL_DOCLING_ENABLED:
                    raise RuntimeError("DOCX native extraction returned no text and local Docling is disabled")
                md = await asyncio.wait_for(convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS)
                task["markdown"] = md
                task["engine"] = "docling"
        elif suffix in {".xlsx", ".xls"}:
            result = await extract_excel_controlled(path, task)
            task.update(result)
            task["engine"] = "openpyxl-stream" if suffix == ".xlsx" else "xlrd-typed"
        elif suffix == ".ppt":
            md, engine, metadata = await convert_legacy_ppt(path, ocr_config, task)
            task.update(markdown=md, engine=engine, **metadata)
        elif suffix == ".pptx":
            try:
                md, engine, parser_metadata = await convert_pptx_without_docling(
                    path, ocr_config, doc_title=task.get("filename"), unit_ids=unit_ids
                )
                if md and md.strip():
                    task["markdown"] = md
                    task["engine"] = engine
                    task.update(parser_metadata)
                elif LOCAL_DOCLING_ENABLED:
                    md = await asyncio.wait_for(convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS)
                    task["markdown"] = md
                    task["engine"] = "docling-local"
                else:
                    task["markdown"] = md
                    task["engine"] = engine
                    task.update(parser_metadata)
            except Exception as pptx_err:
                if LOCAL_DOCLING_ENABLED:
                    logger.warning("Native PPTX conversion failed for %s: %s, falling back to Docling", path.name, pptx_err)
                    md = await asyncio.wait_for(convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS)
                    task["markdown"] = md
                    task["engine"] = "docling-local"
                else:
                    raise
        elif suffix == ".pdf":
            pdf_info = await native_extract("pdf_native", path)
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
            md, engine, parser_metadata = await convert_pdf_structured(path, pdf_info, ocr_config, unit_ids)
            task.update(markdown=md, engine=engine, **parser_metadata)
        else:
            provider = str(ocr_config.get("provider") or OCR_PROVIDER).lower()
            if provider != "baidu" and not is_vlm_available() and not (LOCAL_DOCLING_ENABLED and DOCLING_INSTALLED):
                raise RuntimeError("Image extraction requires configured OCR, VLM, or local Docling")
            parts, skipped = await native_extract("image", path, unit_ids=unit_ids)
            if provider == "baidu" or is_vlm_available():
                skeleton = "\n\n".join(f'<!-- image: {part["key"]} -->' for part in parts)
                md, metadata = await ocr_image_parts_into_markdown(skeleton, parts, ocr_config)
                # Overlapping tiles keep provenance but index repeated OCR lines
                # once per frame. Distinct frames retain their own occurrences.
                previous_by_frame: dict[int, list[str]] = {}
                for source in metadata["source_units"]:
                    page = int(source.get("page", 1))
                    lines = source.get("markdown", "").splitlines()
                    previous = previous_by_frame.get(page, [])
                    maximum = min(len(previous), len(lines), max(1, len(lines) // 6))
                    repeated = 0
                    for count in range(1, maximum + 1):
                        if previous[-count:] == lines[:count]:
                            repeated = count
                    source["markdown"] = "\n".join(lines[repeated:])
                    previous_by_frame[page] = lines
                    source["overlap_lines_removed"] = repeated
                md = "\n\n".join(source.get("markdown", "") for source in metadata["source_units"])
                metadata["source_units"].extend(skipped)
                task.update(markdown=md, engine="ocr-baidu-image" if provider == "baidu" else "vlm-image", **metadata)
            else:
                sections, units = [], skipped
                for part in parts:
                    with tempfile.NamedTemporaryFile(suffix=".png", dir=str(UPLOAD_ROOT), delete=False) as handle:
                        temp_budget.write(handle, Path(part["blob_path"]).read_bytes() if "blob_path" in part else part["blob"], UPLOAD_ROOT)
                        frame_path = Path(handle.name)
                    try:
                        text = await convert_with_docling(frame_path)
                        text = source_contract.body_text(text)
                        units.append(source_contract.unit(part["key"], "image", text, markdown=text, page=part["page"], bbox=part["bbox"]))
                        sections.append(text)
                    finally:
                        safe_unlink(frame_path)
                task.update(markdown="\n\n".join(sections), source_units=units, engine="docling-image", native_text_chars=sum(u["native_text_chars"] for u in units), generated_text_chars=0)

        if not task.get("markdown", "").strip():
            raise RuntimeError("Extracted Markdown is empty")
        task["markdown"] = await asyncio.to_thread(normalize_markdown,
            task["markdown"].replace("\x00", "").replace("\u0000", ""),
            str(task.get("filename", "upload.md")),
        )

        # Structured image handlers already own OCR/VLM and source accounting.
        if is_vlm_available() and not task.get("source_units") and task.get("markdown", ""):
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
                logger.warning("VLM enrichment failed for task %s: %s", task_id, safe_error(vlm_err))
                task["vlm_error"] = safe_error(vlm_err)

        if "native_text_chars" not in task:
            count = source_contract.text_chars(source_contract.body_text(task["markdown"]))
            task.update(native_text_chars=count, generated_text_chars=0,
                source_units=[source_contract.unit("document:body", "document", source_contract.body_text(task["markdown"]), markdown=task["markdown"])])
        source_contract.summarize(task)
        source_contract.attach_offsets(task)
        if task["content_text_chars"] == 0:
            raise RuntimeError("Parser returned only scaffolding, without extracted document content")
        task.update(await asyncio.to_thread(assess_content_quality, task["markdown"], suffix, task))
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
        source_contract.summarize(task)
        task["error"] = safe_error(exc)
        logger.error("Error processing task %s: %s", task_id, safe_error(exc))
    finally:
        try:
            account_retained_result(task_id)
            safe_unlink(path)
            cleanup_native(path)
        except Exception:
            pass

@app.post("/parse", response_model=ParseResponse)
async def parse_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    parser_type: str = "docling",
    instance_id: str | None = Form(None),
    unit_ids: str | None = Form(None),
    small_table_rows: int | None = Form(None),
    cache_source_hash: str | None = Form(None),
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
    identity = instance_id if isinstance(instance_id, str) else "legacy"
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", identity):
        tasks.pop(task_id, None)
        raise HTTPException(status_code=400, detail="Invalid instance identity")
    tasks[task_id]["instanceId"] = identity
    try:
        requested = json.loads(unit_ids) if isinstance(unit_ids, str) and unit_ids else []
        if not isinstance(requested, list) or len(requested) > 5000 or any(not isinstance(u, str) or not u or len(u) > 512 for u in requested):
            raise ValueError("Invalid source unit identifiers")
        if isinstance(small_table_rows, int) and not 1 <= small_table_rows <= 501:
            raise ValueError("Invalid inline table preview limit")
        tasks[task_id]["unit_ids"] = list(dict.fromkeys(requested))
        tasks[task_id]["small_table_rows"] = small_table_rows if isinstance(small_table_rows, int) else 200
    except (ValueError, TypeError):
        tasks.pop(task_id, None)
        raise HTTPException(status_code=400, detail="Invalid source selection or table preview limit")
    # Stream the upload straight to disk in bounded chunks. Reading the whole
    # body into memory first would let a few concurrent 200 MiB uploads
    # exhaust worker RAM, and the size limit is now enforced while
    # transferring instead of after the full payload already arrived.
    chunk_size = 8 * 1024 * 1024
    received_bytes = 0
    source_hash = hashlib.sha256()
    try:
        with path.open("wb") as handle:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                received_bytes += len(chunk)
                source_hash.update(chunk)
                if received_bytes > MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail="File exceeds 200 MiB limit")
                if shutil.disk_usage(UPLOAD_ROOT).free < len(chunk) + MAX_FILE_BYTES:
                    raise HTTPException(status_code=503, detail="Parser temporary disk budget exhausted")
                await asyncio.to_thread(temp_budget.write, handle, chunk, UPLOAD_ROOT)
    except BaseException:
        tasks.pop(task_id, None)
        safe_unlink(path)
        raise
    tasks[task_id]["source_hash"] = source_hash.hexdigest()
    if isinstance(cache_source_hash, str) and cache_source_hash and not secrets.compare_digest(cache_source_hash, source_hash.hexdigest()):
        tasks.pop(task_id, None)
        safe_unlink(path)
        raise HTTPException(status_code=409, detail="Original document hash differs from requested retry source")
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
    return {"task_id": task_id, **public_task_result(task)}


@app.post("/parse-execute")
async def execute_document(
    file: UploadFile = File(...),
    parser_type: str = "auto",
    instance_id: str | None = Form(None),
    unit_ids: str | None = Form(None),
    small_table_rows: int | None = Form(None),
    cache_source_hash: str | None = Form(None),
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
        background_tasks=background, file=file, parser_type=parser_type, instance_id=instance_id,
        unit_ids=unit_ids, small_table_rows=small_table_rows, cache_source_hash=cache_source_hash,
        ocr_provider=ocr_provider, ocr_endpoint=ocr_endpoint,
        ocr_api_key=ocr_api_key, ocr_secret_key=ocr_secret_key, _auth=_auth,
    )
    try:
        await background()
        return {"task_id": accepted.task_id, **public_task_result(tasks[accepted.task_id])}
    finally:
        tasks.pop(accepted.task_id, None)


@app.post("/ocr-embedded-images")
async def ocr_embedded_images_endpoint(
    file: UploadFile = File(...),
    ocr_provider: str | None = Form(None),
    ocr_endpoint: str | None = Form(None),
    ocr_api_key: str | None = Form(None),
    ocr_secret_key: str | None = Form(None),
    instance_id: str | None = Form(None),
    _auth: None = Depends(verify_auth),
):
    """OCR embedded images only; used after AnyDoc text extraction.

    AnyDoc produces the document body but never OCRs pictures inside
    .docx/.pptx/.pdf. The API calls this endpoint to append searchable
    image text so figure labels are retrievable.
    """
    filename = Path(file.filename or "upload.bin").name
    suffix = Path(filename).suffix.lower() or ".bin"
    path = UPLOAD_ROOT / f"ocr-embed-{uuid.uuid4()}{suffix}"
    identity = instance_id if isinstance(instance_id, str) else "legacy"
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", identity):
        raise HTTPException(status_code=400, detail="Invalid instance identity")
    try:
        async with _parse_limiter.slot(identity):
            size = 0
            with path.open("wb") as fh:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > OCR_MAX_FILE_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"Embedded-image OCR upload exceeds {OCR_MAX_FILE_BYTES // (1024 * 1024)}MB limit",
                        )
                    await asyncio.to_thread(temp_budget.write, fh, chunk, UPLOAD_ROOT)
            if size == 0:
                raise HTTPException(status_code=400, detail="Empty upload")
            await asyncio.to_thread(structured_excel.check_package, path)
            ocr_config = {
                "provider": (ocr_provider or OCR_PROVIDER).strip().lower(),
                "endpoint": (ocr_endpoint or BAIDU_OCR_ENDPOINT).strip(),
                "api_key": ocr_api_key or BAIDU_OCR_API_KEY,
                "secret_key": ocr_secret_key or BAIDU_OCR_SECRET_KEY,
            }
            identity_token = artifact_cache.instance_identity.set(identity)
            inline_token = source_contract.inline_asset_bytes.set(0)
            assets_token = source_contract.asset_artifacts.set({})
            try:
                markdown, metadata = await ocr_embedded_images_fragments(path, ocr_config)
            finally:
                artifact_cache.instance_identity.reset(identity_token)
                source_contract.inline_asset_bytes.reset(inline_token)
                source_contract.asset_artifacts.reset(assets_token)
            return {"markdown": markdown, **metadata}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Embedded-image OCR failed for %s: %s", filename, safe_error(exc))
        raise HTTPException(status_code=500, detail="Embedded-image OCR failed")
    finally:
        safe_unlink(path)
        cleanup_native(path)

if __name__ == "__main__":
    import argparse

    import uvicorn

    # `python -m src.main` sets __package__='src' and puts the worker root on
    # sys.path, so the app must be referenced as src.main:app there, and as
    # main:app when the file is executed directly with PYTHONPATH=src. Binding
    # arguments are forwarded so the module entrypoint stays configurable
    # instead of always stealing port 8100.
    options = argparse.ArgumentParser(description='LLMWiki Parser Worker')
    options.add_argument('--host', default='0.0.0.0')
    options.add_argument('--port', type=int, default=8100)
    parsed = options.parse_args()
    uvicorn.run(f"{'src.' if __package__ else ''}main:app", host=parsed.host, port=parsed.port)

_maxsim_limiter = FairLimiter(env_int('MAXSIM_GLOBAL_CONCURRENCY', 2), queue_limit=16, per_instance=1)

@app.post('/maxsim')
async def shared_maxsim(request: Request, _auth: None = Depends(verify_auth)):
    import json
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail='MaxSim payload budget exceeded')
    try:
        data = json.loads(payload)
        identity = data['instanceId']
        if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', identity):
            raise ValueError('Instance identity required')
        if data.get('contract') != 'cosine-maxsim-mean-v1':
            raise ValueError('MaxSim contract mismatch')
        async with _maxsim_limiter.slot(identity):
            with tempfile.TemporaryDirectory(prefix='maxsim-') as directory:
                source, target = Path(directory)/'input.json', Path(directory)/'output.json'
                await asyncio.to_thread(source.write_bytes, payload)
                del payload
                del data
                work = asyncio.create_task(run_process([sys.executable, str(Path(__file__).with_name('maxsim_job.py')), str(source), str(target)], env_float('MAXSIM_TIMEOUT_SECONDS', 5)))
                try:
                    while not work.done():
                        await asyncio.wait({work}, timeout=.1)
                        if await request.is_disconnected():
                            work.cancel()
                            raise HTTPException(status_code=499, detail='MaxSim caller disconnected')
                    await work
                    return json.loads(await asyncio.to_thread(target.read_text, encoding='utf-8'))
                finally:
                    if not work.done():
                        work.cancel()
                        try:
                            await work
                        except asyncio.CancelledError:
                            pass
    except HTTPException:
        raise
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (RuntimeError, asyncio.TimeoutError) as error:
        raise HTTPException(status_code=503, detail='MaxSim capacity or timeout; retain authorized core ranking') from error

@app.get('/resource-metrics')
def resource_metrics(_auth: None = Depends(verify_auth)):
    owned = temp_budget.owned_bytes(UPLOAD_ROOT)
    return {'parser': {'active': _parse_limiter.active, 'queued': sum(len(q) for q in _parse_limiter.queues.values()), 'runningByInstance': _parse_limiter.running},
            'temporaries': {'owned_bytes': owned, 'budget_bytes': temp_budget.budget_bytes()},
            'maxsim': {'active': _maxsim_limiter.active, 'queued': sum(len(q) for q in _maxsim_limiter.queues.values()), 'runningByInstance': _maxsim_limiter.running}}


@app.get("/artifacts/{artifact_id}")
def download_artifact(artifact_id: str, instance_id: str, _auth: None = Depends(verify_auth)):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", instance_id):
        raise HTTPException(status_code=404, detail="Parser artifact not found")
    path = artifact_store.resolve(artifact_id, instance_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Parser artifact not found")
    return FileResponse(path, media_type=artifact_store.media_type(artifact_id),
                        filename=artifact_id, headers={"Cache-Control": "private, no-store"})
