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

UPLOAD_ROOT = Path("/tmp/llmwiki/parser")
MAX_FILE_BYTES = 50 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".md", ".txt", ".csv", ".html", ".htm", ".doc", ".docx", ".pdf", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg"}
ANTIWORD_BIN = os.environ.get("ANTIWORD_BIN", "antiword")
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
    # startup
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    cleanup_task = asyncio.create_task(periodic_cleanup())
    yield
    # shutdown
    cleanup_task.cancel()

app = FastAPI(title="LLMWiki Parser Worker", version="0.2.0", lifespan=lifespan)

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
    """Extract old binary .doc files to UTF-8 text before indexing.

    LibreOffice is the preferred full-fidelity converter when available. The
    production image currently ships the lightweight antiword fallback, which
    is sufficient for searchable text and avoids rejecting legacy Word files.
    """
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

async def process_file(task_id: str, path: Path, parser_type: str) -> None:
    task = tasks[task_id]
    task["status"] = "processing"
    try:
        suffix = path.suffix.lower()
        if suffix in {".md", ".txt", ".csv", ".html", ".htm"}:
            content = await asyncio.to_thread(path.read_bytes)
            task["markdown"] = extract_plaintext(path.name, content)
        elif suffix == ".doc":
            task["conversion"] = "antiword"
            task["markdown"] = await asyncio.to_thread(extract_legacy_word, path)
        else:
            # Heavy document parsers are optional in development but are the
            # only supported path for binary office/PDF/image documents.
            try:
                # Some CPU-only torch builds do not ship torchvision's custom
                # NMS operators, while torchvision registers their fake
                # implementations during import. Define the schemas first so
                # Docling can load its layout model on those builds as well.
                global _torchvision_compat_lib
                import torch
                if _torchvision_compat_lib is None:
                    try:
                        _torchvision_compat_lib = torch.library.Library("torchvision", "DEF")
                    except RuntimeError:
                        # Another imported torch component may already own the
                        # namespace; FRAGMENT allows adding only the missing
                        # compatibility schemas without a second DEF block.
                        _torchvision_compat_lib = torch.library.Library("torchvision", "FRAGMENT")
                for operator in ("nms", "qnms"):
                    try:
                        _torchvision_compat_lib.define(
                            f"{operator}(Tensor boxes, Tensor scores, float iou_threshold) -> Tensor"
                        )
                    except Exception:
                        pass
                from docling.document_converter import DocumentConverter
            except ImportError as exc:
                raise RuntimeError("docling is not installed; install parser-worker dependencies before processing binary documents") from exc
            converter = DocumentConverter()
            result = await asyncio.to_thread(converter.convert, str(path))
            task["markdown"] = result.document.export_to_markdown()
        task["status"] = "completed"
    except Exception as exc:
        task["status"] = "failed"
        task["error"] = f"Processing failed for {task.get('filename', 'unknown')}: {type(exc).__name__}"
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

    filename = Path(file.filename or "upload.bin").name
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {suffix or 'unknown'}")
        
    if file.size and file.size > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MiB limit")
        
    content = await file.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MiB limit")

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
    uvicorn.run("main:app", host="0.0.0.0", port=8000)
