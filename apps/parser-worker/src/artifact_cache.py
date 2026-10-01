"""Credential-free, bounded cache for page/image artifacts in the shared worker."""
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from contextvars import ContextVar

instance_identity: ContextVar[str] = ContextVar("parser_instance", default="legacy")
ROOT = Path(os.environ.get("PARSER_ARTIFACT_CACHE", "/tmp/llmwiki/parser-artifacts"))
MAX_BYTES = int(os.environ.get("PARSER_ARTIFACT_CACHE_MAX_BYTES", str(256 * 1024 * 1024)))
TTL_SECONDS = int(os.environ.get("PARSER_ARTIFACT_CACHE_TTL_SECONDS", str(7 * 86400)))

def key(blob: bytes, contract: dict) -> str:
    payload = json.dumps([instance_identity.get(), contract], sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(payload + b"\x00" + blob).hexdigest()

def read(cache_key: str):
    path = ROOT / (cache_key + ".json")
    try:
        if time.time() - path.stat().st_mtime > TTL_SECONDS:
            path.unlink(missing_ok=True)
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

def write(cache_key: str, artifact):
    try:
        payload = json.dumps(artifact, ensure_ascii=False).encode()
        if len(payload) > min(MAX_BYTES, 8 * 1024 * 1024):
            return
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        entries = []
        for path in ROOT.glob("*.json"):
            try:
                info = path.stat()
                entries.append((info.st_mtime, info.st_size, path))
            except OSError:
                continue
        entries.sort()
        total = sum(item[1] for item in entries)
        for _, size, path in entries:
            if total + len(payload) <= MAX_BYTES:
                break
            try:
                path.unlink(missing_ok=True)
                total -= size
            except OSError:
                pass
        path = ROOT / (cache_key + ".json")
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(payload)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError):
        # Optional reuse never converts valid parser output into an ingestion failure.
        return
