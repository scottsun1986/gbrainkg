from __future__ import annotations

import asyncio
import html
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel

app = FastAPI(title="LLMWiki Parser Worker", version="0.2.0")
UPLOAD_ROOT = Path("/tmp/llmwiki/parser")
MAX_FILE_BYTES = 50 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".md", ".txt", ".csv", ".html", ".htm", ".doc", ".docx", ".pdf", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg"}
ANTIWORD_BIN = os.environ.get("ANTIWORD_BIN", "/home/scottsun/.local/bin/antiword")
tasks: dict[str, dict[str, Any]] = {}
_torchvision_compat_lib = None


class ParseResponse(BaseModel):
    task_id: str
    status: str
    message: str


@app.get("/health")
def health_check():
    return {"status": "healthy", "version": app.version}


def extract_plaintext(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    text = content.decode("utf-8-sig", errors="replace")
    if suffix in {".html", ".htm"}:
        text = html.unescape(__import__("re").sub(r"<[^>]+>", " ", text))
    return text.strip()


def extract_legacy_word(path: Path) -> str:
    """Extract old binary .doc files to UTF-8 text before indexing.

    LibreOffice is the preferred full-fidelity converter when available. The
    production image currently ships the lightweight antiword fallback, which
    is sufficient for searchable text and avoids rejecting legacy Word files.
    """
    env = os.environ.copy()
    env.setdefault("ANTIWORDHOME", "/home/scottsun/.antiword")
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
        task["error"] = str(exc)


@app.post("/parse", response_model=ParseResponse)
async def parse_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    parser_type: str = "docling",
):
    filename = Path(file.filename or "upload.bin").name
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported file type: {suffix or 'unknown'}")
    content = await file.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MiB limit")

    task_id = str(uuid.uuid4())
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    path = UPLOAD_ROOT / f"{task_id}{suffix}"
    await asyncio.to_thread(path.write_bytes, content)
    tasks[task_id] = {"status": "queued", "filename": filename, "parser_type": parser_type}
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
