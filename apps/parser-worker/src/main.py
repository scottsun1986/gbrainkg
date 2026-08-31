from __future__ import annotations

import asyncio
import html
import logging
import os
import re
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

logger = logging.getLogger('parser-worker')
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Clean proxy environment for httpx/huggingface_hub compatibility
for k in ["ALL_PROXY", "all_proxy"]:
    if os.environ.get(k, "").startswith("socks://"):
        os.environ.pop(k, None)

UPLOAD_ROOT = Path("/tmp/llmwiki/parser")
MAX_FILE_BYTES = 200 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".md", ".txt", ".csv", ".html", ".htm", ".doc", ".docx", ".pdf", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg"}
ANTIWORD_BIN = os.environ.get("ANTIWORD_BIN", "antiword")
DOCLING_TIMEOUT_SECONDS = float(os.environ.get("DOCLING_TIMEOUT_SECONDS", "240"))
PDF_PARSE_MODE = os.environ.get("PDF_PARSE_MODE", "quality").lower()
tasks: dict[str, dict[str, Any]] = {}
_torchvision_compat_lib = None

async def periodic_cleanup():
    while True:
        await asyncio.sleep(300)
        current_time = time.time()
        for tid in list(tasks.keys()):
            t_info = tasks[tid]
            if t_info.get("status") in ("completed", "failed"):
                if current_time - t_info.get("created_at", current_time) > 1800:
                    del tasks[tid]

@asynccontextmanager
async def lifespan(app: FastAPI):
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    cleanup_task = asyncio.create_task(periodic_cleanup())
    yield
    cleanup_task.cancel()

app = FastAPI(title="LLMWiki Parser Worker", version="0.3.0", lifespan=lifespan)

allowed_origins = os.environ.get('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3001').split(',')
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer(auto_error=False)

def verify_auth(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = os.environ.get("AUTH_TOKEN")
    if token:
        if not credentials or credentials.credentials != token:
            raise HTTPException(status_code=401, detail="Invalid or missing authentication token")

class ParseResponse(BaseModel):
    task_id: str
    status: str
    message: str

@app.get("/health")
def health_check():
    return {"status": "healthy", "version": app.version}

@app.get("/metrics")
def metrics():
    total = len(tasks)
    by_status = {}
    for t in tasks.values():
        s = t.get('status', 'unknown')
        by_status[s] = by_status.get(s, 0) + 1
    return {'total_tasks': total, 'by_status': by_status}

def extract_plaintext(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    text = content.decode("utf-8-sig", errors="replace")
    if suffix in {".html", ".htm"}:
        text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return text.strip()

def extract_legacy_word(path: Path) -> str:
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
                heading_match = re.search(r"heading\s*([1-6])", style_name)
                lines.append(f"{'#' * int(heading_match.group(1))} {txt}" if heading_match else txt)
            else:
                rows = []
                for row in block.rows:
                    cells = [cell.text.strip().replace("\n", " ").replace("|", "\\|") for cell in row.cells]
                    if any(cells):
                        rows.append(cells)
                if rows:
                    width = max(len(row) for row in rows)
                    normalized = [row + [""] * (width - len(row)) for row in rows]
                    t_lines = ["| " + " | ".join(normalized[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
                    t_lines.extend("| " + " | ".join(row) + " |" for row in normalized[1:])
                    lines.append("\n".join(t_lines))
        return "\n\n".join(lines).strip()
    except Exception as e:
        logger.warning(f"python-docx extraction failed for {path}: {e}")
        return ""

def extract_pdf_native(path: Path) -> str:
    """Extract native PDF text & structure via pypdf in milliseconds."""
    try:
        import pypdf
        reader = pypdf.PdfReader(str(path))
        pages_text = []
        for i, page in enumerate(reader.pages):
            txt = (page.extract_text() or "").strip()
            if txt:
                pages_text.append(f"## 第 {i+1} 页\n\n{txt}")
        if pages_text:
            return f"# {path.stem}\n\n" + "\n\n---\n\n".join(pages_text)
    except Exception as e:
        logger.warning(f"pypdf extraction failed for {path}: {e}")
    return ""

def extract_excel(path: Path) -> str:
    """Extract .xlsx / .xls sheets to Markdown tables."""
    try:
        import openpyxl
        wb = openpyxl.load_workbook(str(path), data_only=True)
        sheets_md = []
        for sheetname in wb.sheetnames:
            sheet = wb[sheetname]
            rows = list(sheet.iter_rows(values_only=True))
            if not rows:
                continue
            table_lines = [f"### 工作表：{sheetname}\n"]
            header = [str(cell if cell is not None else "") for cell in rows[0]]
            table_lines.append("| " + " | ".join(header) + " |")
            table_lines.append("| " + " | ".join(["---"] * len(header)) + " |")
            for row in rows[1:]:
                if all(c is None or str(c).strip() == "" for c in row):
                    continue
                cells = [str(c if c is not None else "").replace("\n", " ") for c in row]
                table_lines.append("| " + " | ".join(cells) + " |")
            sheets_md.append("\n".join(table_lines))
        return "\n\n".join(sheets_md)
    except Exception as e:
        logger.warning(f"openpyxl extraction failed for {path}: {e}")
        return ""

async def convert_with_docling(path: Path) -> str:
    """Docling deep layout extraction with compatibility guard."""
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
    return await asyncio.to_thread(_run)

async def process_file(task_id: str, path: Path, parser_type: str) -> None:
    task = tasks[task_id]
    task["status"] = "processing"
    try:
        suffix = path.suffix.lower()
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
                md = await convert_with_docling(path)
                task["markdown"] = md
                task["engine"] = "docling"
        elif suffix in {".xlsx", ".xls"}:
            md = await asyncio.to_thread(extract_excel, path)
            if md:
                task["markdown"] = md
                task["engine"] = "openpyxl"
            else:
                md = await convert_with_docling(path)
                task["markdown"] = md
                task["engine"] = "docling"
        elif suffix == ".pdf":
            native_md = await asyncio.to_thread(extract_pdf_native, path)
            if PDF_PARSE_MODE == "fast" and native_md and len(native_md.strip()) > 50:
                task["markdown"] = native_md
                task["engine"] = "pypdf-native"
            else:
                # Layout-aware extraction is the production default. It keeps
                # tables, columns and reading order that plain PDF text often
                # destroys; native extraction remains a fail-open fallback.
                try:
                    md = await asyncio.wait_for(convert_with_docling(path), timeout=DOCLING_TIMEOUT_SECONDS)
                    task["markdown"] = md
                    task["engine"] = "docling"
                except Exception as docling_err:
                    logger.warning(f"Docling OCR on {path.name} failed/timed out: {docling_err}")
                    if native_md:
                        task["markdown"] = native_md
                        task["engine"] = "pypdf-fallback"
                    else:
                        raise docling_err
        else:
            # PPT / images / others
            md = await convert_with_docling(path)
            task["markdown"] = md
            task["engine"] = "docling"

        if not task.get("markdown", "").strip():
            raise RuntimeError("Extracted Markdown is empty")
        task["markdown"] = task["markdown"].replace("\x00", "").replace("\u0000", "")
        task["status"] = "completed"
        logger.info(f"Task {task_id} completed successfully via engine={task.get('engine')}")
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
    _auth: None = Depends(verify_auth),
):
    if len(tasks) >= 5000:
        oldest_tid = min(tasks.keys(), key=lambda k: tasks[k].get("created_at", float('inf')))
        del tasks[oldest_tid]

    filename = Path(file.filename or "upload.md").name
    suffix = Path(filename).suffix.lower()
    if not suffix:
        suffix = ".md"
        filename = f"{filename}.md"
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {suffix or 'unknown'}")
        
    if file.size and file.size > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 200 MiB limit")
        
    content = await file.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 200 MiB limit")

    task_id = str(uuid.uuid4())
    path = UPLOAD_ROOT / f"{task_id}{suffix}"
    await asyncio.to_thread(path.write_bytes, content)
    tasks[task_id] = {"status": "queued", "filename": filename, "parser_type": parser_type, "created_at": time.time()}
    background_tasks.add_task(process_file, task_id, path, parser_type)
    return ParseResponse(task_id=task_id, status="accepted", message=f"File {filename} queued for parsing")

@app.get("/parse/{task_id}")
def parse_status(task_id: str):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Parse task not found")
    return {"task_id": task_id, **task}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8100)
