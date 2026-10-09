"""Shared parser temporary byte budget and orphan reclamation."""
import os
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import temp_budget


class OwnedBytesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'parser'
        self.root.mkdir()

    def write(self, relative, size):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'x' * size)
        return path

    def test_owned_bytes_counts_nested_transient_workspaces(self):
        self.write('task-source.xlsx', 10)
        self.write('task-source-native-1/blob-1.bin', 20)
        self.write('task-source-native-1/result.json', 5)
        self.assertEqual(temp_budget.owned_bytes(self.root), 35)

    def test_reclaim_removes_only_entries_older_than_the_limit(self):
        stale = self.write('stale-source.xlsx', 10)
        fresh = self.write('fresh-source.xlsx', 10)
        now = time.time()
        os.utime(stale, (now - 10_000, now - 10_000))
        os.utime(fresh, (now, now))
        removed = temp_budget.reclaim(self.root, ttl_seconds=3600)
        self.assertEqual(removed, ['stale-source.xlsx'])
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_reclaim_removes_abandoned_native_workspace(self):
        workspace = self.write('killed-native-1/blob-1.bin', 30)
        workspace.parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        os.utime(workspace.parent, (now - 10_000, now - 10_000))
        os.utime(workspace, (now - 10_000, now - 10_000))
        removed = temp_budget.reclaim(self.root, ttl_seconds=3600)
        self.assertEqual(removed, ['killed-native-1'])
        self.assertFalse(workspace.parent.exists())

    def test_in_flight_floor_protects_live_task_temporaries(self):
        """A task that legitimately runs for an hour must not be swept."""
        live = self.write('live-source.xlsx', 10)
        floor = time.time() - 3600
        os.utime(live, (floor, floor))
        # Older than the TTL but newer than the oldest in-flight task: live.
        self.assertEqual(temp_budget.reclaim(self.root, in_flight_floor=floor, ttl_seconds=60), [])
        self.assertTrue(live.exists())
        # With the floor gone (nothing in flight), the same file is an orphan.
        self.assertEqual(temp_budget.reclaim(self.root, in_flight_floor=None, ttl_seconds=60), ['live-source.xlsx'])

    def test_reclaim_under_pressure_is_a_no_op_while_there_is_headroom(self):
        self.write('small-source.docx', 1024)
        with patch.object(temp_budget, 'budget_bytes', return_value=1024 * 1024):
            self.assertEqual(temp_budget.reclaim_under_pressure(self.root, None), [])

    def test_reclaim_under_pressure_sweeps_when_budget_is_exhausted(self):
        self.write('a-source.xlsx', 1024)
        with patch.object(temp_budget, 'budget_bytes', return_value=1024):
            self.assertEqual(temp_budget.reclaim_under_pressure(self.root, ttl_seconds=0), ['a-source.xlsx'])

    def test_write_is_allowed_once_orphans_are_reclaimed(self):
        """The production failure mode: an OOM-restart left files behind and
        every later upload was rejected until a human cleaned the volume."""
        orphan = self.write('orphan-source.xlsx', 4096)
        now = time.time()
        os.utime(orphan, (now - 10_000, now - 10_000))
        target = self.root / 'inline.bin'
        with patch.object(temp_budget, 'budget_bytes', return_value=2048):
            with self.assertRaises(ValueError):
                temp_budget.write_bytes(target, b'y' * 16, self.root)
            temp_budget.reclaim(self.root, ttl_seconds=3600)
            temp_budget.write_bytes(target, b'y' * 16, self.root)
        self.assertEqual(target.read_bytes(), b'y' * 16)

    def test_reclaim_tolerates_a_missing_root(self):
        self.assertFalse(temp_budget.reclaim(self.root / 'absent'))
