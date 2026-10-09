"""Transient, instance-scoped streamed artifacts; API owns durable ACL/storage."""
from __future__ import annotations

import fcntl
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

try:
    from src.env_config import env_int
except ImportError:
    from env_config import env_int

ROOT = Path(os.environ.get('PARSER_STREAM_ARTIFACT_ROOT', '/tmp/llmwiki/parser-streams'))
MAX_BYTES = env_int('PARSER_STREAM_ARTIFACT_MAX_BYTES', 1024 * 1024 * 1024)
MAX_ARTIFACT_BYTES = env_int('PARSER_STREAM_ARTIFACT_FILE_BYTES', 200 * 1024 * 1024)
TTL_SECONDS = env_int('PARSER_STREAM_ARTIFACT_TTL_SECONDS', 3600)
ID_PATTERN = re.compile(r'^[a-f0-9]{32}$')


@contextmanager
def _lock():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT / '.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _cleanup():
    now = time.time()
    for meta in ROOT.glob('*.meta'):
        try:
            if now - meta.stat().st_mtime <= TTL_SECONDS:
                continue
            meta.with_suffix('.jsonl').unlink(missing_ok=True)
            meta.unlink(missing_ok=True)
        except OSError:
            pass
    for orphan in ROOT.glob('*.jsonl'):
        try:
            if not orphan.with_suffix('.meta').exists() and now - orphan.stat().st_mtime > TTL_SECONDS:
                orphan.unlink(missing_ok=True)
        except OSError:
            pass
    for pending in ROOT.glob('*.pending'):
        try:
            if now - pending.stat().st_mtime > TTL_SECONDS:
                pending.unlink(missing_ok=True)
        except OSError:
            pass


class Writer:
    """A bounded JSONL spool; metadata appears only after a complete write."""
    def __init__(self, instance_id: str):
        self.instance_id = instance_id
        self.id = uuid.uuid4().hex
        self.size = 0
        self.buffer: list[str] = []
        self.buffer_size = 0
        with _lock():
            _cleanup()
            self.path = ROOT / (self.id + '.pending')
            self.handle = self.path.open('x', encoding='utf-8')

    def write(self, row: dict):
        line = json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n'
        size = len(line.encode('utf-8'))
        if self.size + size > MAX_ARTIFACT_BYTES:
            raise ValueError('Structured table exceeds artifact output budget')
        # Bound memory while avoiding a directory scan and flock for every row.
        # Buffered bytes are not on disk; each flush checks all actual outputs
        # under the shared lock before writing any of them.
        if self.buffer_size + size > 64 * 1024:
            self._flush()
        self.buffer.append(line)
        self.buffer_size += size
        self.size += size
        if self.buffer_size >= 64 * 1024:
            self._flush()

    def _flush(self):
        if not self.buffer_size:
            return
        with _lock():
            total = sum(p.stat().st_size for p in ROOT.iterdir() if p.suffix in {'.jsonl', '.pending'})
            if total + self.buffer_size > MAX_BYTES:
                raise ValueError('Shared structured-artifact disk budget exhausted')
            self.handle.writelines(self.buffer)
            self.handle.flush()
            self.buffer.clear()
            self.buffer_size = 0


    def append_file(self, source: Path):
        self._flush()
        size = source.stat().st_size
        if self.size + size > MAX_ARTIFACT_BYTES:
            raise ValueError('Structured table exceeds artifact output budget')
        with _lock():
            total = sum(p.stat().st_size for p in ROOT.iterdir() if p.suffix in {'.jsonl', '.pending'})
            if total + size > MAX_BYTES:
                raise ValueError('Shared structured-artifact disk budget exhausted')
            with source.open('r', encoding='utf-8') as handle:
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    self.handle.write(chunk)
            self.handle.flush()
            self.size += size

    def finish(self) -> str:
        self._flush()
        self.handle.close()
        with _lock():
            self.path.replace(ROOT / (self.id + '.jsonl'))
            (ROOT / (self.id + '.meta')).write_text(json.dumps({
                'instance_id': self.instance_id, 'bytes': self.size, 'created_at': time.time(),
            }), encoding='utf-8')
        return self.id

    def abort(self):
        self.handle.close()
        self.buffer.clear()
        self.buffer_size = 0
        with _lock():
            self.path.unlink(missing_ok=True)


def resolve(artifact_id: str, instance_id: str) -> Path | None:
    if not ID_PATTERN.fullmatch(artifact_id):
        return None
    with _lock():
        _cleanup()
        try:
            meta = json.loads((ROOT / (artifact_id + '.meta')).read_text(encoding='utf-8'))
            path = ROOT / (artifact_id + '.jsonl')
            if meta['instance_id'] != instance_id or time.time() - meta['created_at'] > TTL_SECONDS:
                return None
            return path if path.is_file() else None
        except (OSError, ValueError, KeyError):
            return None


def remove(artifact_id: str, instance_id: str):
    path = resolve(artifact_id, instance_id)
    if path is not None:
        with _lock():
            path.unlink(missing_ok=True)
            path.with_suffix('.meta').unlink(missing_ok=True)


def publish_blob(blob: bytes, instance_id: str, mime: str) -> str:
    writer = Writer(instance_id)
    try:
        if len(blob) > MAX_ARTIFACT_BYTES:
            raise ValueError('Image asset exceeds artifact output budget')
        writer.handle.close()
        with _lock():
            total = sum(p.stat().st_size for p in ROOT.iterdir() if p.suffix in {'.jsonl', '.pending'})
            if total + len(blob) > MAX_BYTES:
                raise ValueError('Shared structured-artifact disk budget exhausted')
            writer.path.write_bytes(blob)
            writer.path.replace(ROOT / (writer.id + '.jsonl'))
            (ROOT / (writer.id + '.meta')).write_text(json.dumps({
                'instance_id': instance_id, 'bytes': len(blob), 'created_at': time.time(), 'mime': mime,
            }), encoding='utf-8')
        return writer.id
    except BaseException:
        writer.abort()
        raise


def media_type(artifact_id: str) -> str:
    try:
        return json.loads((ROOT / (artifact_id + '.meta')).read_text(encoding='utf-8')).get('mime', 'application/x-ndjson')
    except (OSError, ValueError):
        return 'application/x-ndjson'

