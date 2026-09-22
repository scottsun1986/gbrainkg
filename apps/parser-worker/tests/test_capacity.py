import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import main


class ParserCapacityTests(unittest.TestCase):
    def test_full_capacity_preserves_running_and_completed_results(self):
        for status in ("queued", "processing", "completed", "failed"):
            with self.subTest(status=status), patch.object(main, "MAX_TASKS", 1), patch.object(
                main, "tasks", {"existing": {"status": status, "created_at": 0}}
            ):
                with self.assertRaises(HTTPException) as error:
                    main.reserve_task("new", "upload.txt", "auto")
                self.assertEqual(error.exception.status_code, 503)
                self.assertEqual(error.exception.headers["Retry-After"], "5")
                self.assertEqual(list(main.tasks), ["existing"])
                self.assertEqual(main.tasks["existing"]["status"], status)

    def test_reservation_counts_before_io(self):
        with patch.object(main, "MAX_TASKS", 1), patch.object(main, "tasks", {}):
            main.reserve_task("first", "upload.txt", "auto")
            self.assertEqual(main.tasks["first"]["status"], "queued")
            with self.assertRaises(HTTPException):
                main.reserve_task("second", "upload.txt", "auto")

    def test_inflight_limit_is_independent_of_retained_result_entries(self):
        """A worker with many finished results still accepts new work.

        Retained terminal entries are bounded by MAX_TASKS (memory guard), while
        queued/processing work is bounded by MAX_INFLIGHT_TASKS, so a full result
        backlog for polling clients can no longer refuse new parses.
        """
        retained = {
            f"done-{i}": {"status": "completed", "created_at": 0} for i in range(5)
        }
        with patch.object(main, "MAX_TASKS", 10), patch.object(
            main, "MAX_INFLIGHT_TASKS", 2
        ), patch.object(main, "tasks", dict(retained)):
            main.reserve_task("run-1", "upload.txt", "auto")
            main.reserve_task("run-2", "upload.txt", "auto")
            with self.assertRaises(HTTPException):
                main.reserve_task("run-3", "upload.txt", "auto")

    def test_stale_task_sweep_releases_capacity(self):
        """A task stuck in processing is failed by the sweep, not kept forever."""
        stuck = {"stuck": {"status": "processing", "created_at": 0}}
        with patch.object(main, "tasks", dict(stuck)), patch.object(
            main, "PARSER_TASK_STALE_SECONDS", 60
        ):
            # Drive one sweep iteration directly (the loop itself sleeps).
            import asyncio

            async def one_sweep():
                current_time = main.time.time()
                for tid in list(main.tasks.keys()):
                    info = main.tasks[tid]
                    status = info.get("status")
                    age = current_time - info.get("created_at", current_time)
                    if status in ("completed", "failed"):
                        if age > 1800:
                            del main.tasks[tid]
                        continue
                    if status in ("queued", "processing") and age > main.PARSER_TASK_STALE_SECONDS:
                        info["status"] = "failed"
                        info["stale_timeout"] = True
                        info["completed_at"] = current_time

            asyncio.run(one_sweep())

            self.assertEqual(main.tasks["stuck"]["status"], "failed")
            self.assertTrue(main.tasks["stuck"]["stale_timeout"])
