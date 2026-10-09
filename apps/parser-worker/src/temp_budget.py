"""Shared actual-byte accounting and orphan reclamation for parser temporaries."""
from typing import Iterable, TYPE_CHECKING
import fcntl
import os
import shutil
import time
from pathlib import Path

if TYPE_CHECKING or __package__:
    from .env_config import env_int
else:
    from env_config import env_int

# A hard kill (OOM under MemoryMax, SIGKILL, container removal) skips every
# cleanup_native/finally path. The parser upload root is a persistent volume,
# so an abandoned <task-uuid>.xlsx or <stem>-native-* directory would otherwise
# sit there forever and permanently consume the shared byte budget.
DEFAULT_ORPHAN_TTL_SECONDS = 2 * 5400


def budget_bytes() -> int:
    return env_int('PARSER_MAX_TEMP_BYTES', 1024 * 1024 * 1024)


def orphan_ttl_seconds() -> int:
    return env_int('PARSER_TEMP_ORPHAN_TTL_SECONDS', DEFAULT_ORPHAN_TTL_SECONDS)


def _budget_lock(root: Path):
    return (root.parent / (root.name + '.budget.lock')).open('a')


def owned_bytes(root: Path) -> int:
    """Actual bytes of parser-owned temporaries under ``root``.

    Everything directly below the parser upload root is transient: uploaded
    sources, native workspaces, image/spill files and PDF subsets. Durable
    document storage is the API's own upload root on a separate volume, so no
    persistent record is ever accounted or removed here.
    """
    total = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            if entry.name != '.budget.lock':
                                total += entry.stat().st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def reclaim(root: Path, in_flight_floor: float | None = None,
            ttl_seconds: int | None = None) -> list[str]:
    """Remove temporaries abandoned by a killed task; return reclaimed names.

    An entry is only a candidate when it is older than ``ttl_seconds`` *and*
    older than ``in_flight_floor`` (the creation time of the oldest task still
    queued or processing). The floor is what makes an aggressive sweep safe:
    anything a live task may still hold has an mtime at or after that moment.
    """
    ttl = ttl_seconds if ttl_seconds is not None else orphan_ttl_seconds()
    limit = time.time() - ttl
    if in_flight_floor is not None:
        limit = min(limit, in_flight_floor)
    if not root.is_dir():
        return []
    removed: list[str] = []
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return removed
    for entry in entries:
        try:
            if entry.stat().st_mtime >= limit:
                continue
        except OSError:
            continue
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)
        removed.append(entry.name)
    return removed


def reclaim_under_pressure(root: Path, in_flight_floor: float | None = None,
                           ttl_seconds: int | None = None) -> list[str]:
    """Sweep only when owned bytes approach the budget, so a healthy worker
    never touches files that graceful cleanup would have removed anyway."""
    if owned_bytes(root) <= budget_bytes() * 0.9:
        return []
    return reclaim(root, in_flight_floor, ttl_seconds)


def write(handle, content, root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with _budget_lock(root) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            total = owned_bytes(root)
            size = len(content.encode('utf-8')) if isinstance(content, str) else len(content)
            if total + size > budget_bytes():
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
