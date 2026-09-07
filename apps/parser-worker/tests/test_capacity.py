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
