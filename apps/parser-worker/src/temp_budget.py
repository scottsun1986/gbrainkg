"""Shared actual-byte accounting for uploads and native temporary outputs."""
import fcntl
import shutil
from pathlib import Path
from env_config import env_int


def write(handle, content, root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root.parent / (root.name + '.budget.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            total = 0
            for path in root.rglob('*'):
                if path.is_file() and path.name != '.budget.lock':
                    try:
                        total += path.stat().st_size
                    except OSError:
                        continue
            size = len(content.encode('utf-8')) if isinstance(content, str) else len(content)
            if total + size > env_int('PARSER_MAX_TEMP_BYTES', 1024 * 1024 * 1024):
                raise ValueError('Shared parser temporary byte budget exhausted')
            if shutil.disk_usage(root).free < size + 64 * 1024 * 1024:
                raise ValueError('Parser temporary disk budget exhausted')
            handle.write(content)
            handle.flush()
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def write_bytes(path: Path, content: bytes, root: Path):
    with path.open('wb') as handle:
        write(handle, content, root)


def write_text(path: Path, content: str, root: Path):
    with path.open('w', encoding='utf-8') as handle:
        write(handle, content, root)
