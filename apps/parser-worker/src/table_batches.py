"""Resume completed row batches for the same source hash/instance/contract.

No partial table is labelled complete: a complete artifact is assembled only
when traversal reaches the source table end. Partial failed attempts preserve
finished batches and discard their current uncommitted batch.
"""
from __future__ import annotations
from typing import TYPE_CHECKING
import hashlib
import json
from typing import Any
from pathlib import Path
from contextvars import ContextVar

if TYPE_CHECKING or __package__:
    from . import artifact_store, artifact_cache
    from .env_config import env_int
else:
    import artifact_store
    import artifact_cache
    from env_config import env_int

source_hash: ContextVar[str] = ContextVar('table_source_hash', default='')
BATCH_ROWS = env_int('PARSER_TABLE_BATCH_ROWS', 1000)
CONTRACT = 'typed-original-coordinate-v3'


class BatchedWriter:
    def __init__(self, identity: str, table_id: str):
        self.identity = identity
        key_material = json.dumps([identity, source_hash.get(), CONTRACT, table_id, BATCH_ROWS], ensure_ascii=False).encode()
        self.key = hashlib.sha256(key_material).hexdigest()
        self.manifest = artifact_cache.read(self.key) if source_hash.get() else None
        self.manifest = self.manifest or {'batches': []}
        self.previous = self.manifest.get('batches', [])
        self.batches: list[dict[str, Any]] = []
        self.current = None
        self.count = self.total = self.reused = 0
        self.cached = None
        self._prepare()

    def _prepare(self):
        self.count = 0
        index = len(self.batches)
        candidate = self.previous[index] if index < len(self.previous) else None
        self.cached = candidate if candidate and artifact_store.resolve(candidate['artifact_id'], self.identity) else None
        self.current = None

    def write(self, row):
        self.count += 1
        self.total += 1
        if self.cached is None:
            if self.current is None:
                self.current = artifact_store.Writer(self.identity)
            self.current.write(row)
        elif self.count > self.cached['row_count']:
            # A matching hash/contract must produce matching batch boundaries.
            # Refuse contradictory cache entries rather than silently truncate.
            raise ValueError('Structured batch source/contract mismatch')
        if self.count == BATCH_ROWS:
            self._commit()
            self._prepare()

    def _commit(self):
        if not self.count:
            return
        if self.cached is not None:
            if self.count != self.cached['row_count']:
                raise ValueError('Structured batch count mismatch')
            record = self.cached
            self.reused += 1
        else:
            record = {'artifact_id': self.current.finish(), 'row_count': self.count}
            self.current = None
        self.batches.append(record)
        if source_hash.get():
            artifact_cache.write(self.key, {'batches': self.batches + self.previous[len(self.batches):]})

    def finish(self):
        self._commit()
        cached_id = self.manifest.get('complete_artifact_id')
        if cached_id and self.batches == self.previous and artifact_store.resolve(cached_id, self.identity):
            artifact_cache.write(self.key, {'batches': self.batches, 'complete_artifact_id': cached_id})
            return cached_id
        complete = artifact_store.Writer(self.identity)
        try:
            for batch in self.batches:
                path = artifact_store.resolve(batch['artifact_id'], self.identity)
                if path is None:
                    raise ValueError('Structured row batch expired before completion')
                complete.append_file(path)
            identifier = complete.finish()
        except BaseException:
            complete.abort()
            raise
        if source_hash.get():
            artifact_cache.write(self.key, {'batches': self.batches, 'complete_artifact_id': identifier})
        return identifier

    def abort(self):
        if self.current:
            self.current.abort()
            self.current = None
