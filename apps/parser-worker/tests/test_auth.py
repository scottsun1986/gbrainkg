"""Exercise the actual ASGI status route without starting OCR or external services."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from main import app, tasks


class ParserStatusAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_requires_service_token(self):
        task_id = "auth-regression-fixture"
        tasks[task_id] = {"status": "completed", "markdown": "private document"}
        try:
            with patch.dict(os.environ, {"AUTH_TOKEN": "test-service-token"}):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://parser"
                ) as client:
                    for headers in ({}, {"Authorization": "Bearer wrong"}):
                        response = await client.get(f"/parse/{task_id}", headers=headers)
                        self.assertEqual(response.status_code, 401)
                        self.assertNotIn("private document", response.text)
                    response = await client.get(
                        f"/parse/{task_id}",
                        headers={"Authorization": "Bearer test-service-token"},
                    )
                    self.assertEqual(response.status_code, 200)
        finally:
            tasks.pop(task_id, None)
