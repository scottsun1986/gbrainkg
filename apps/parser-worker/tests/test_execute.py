import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import main


class ExecuteContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_execution_returns_result_without_durable_python_task(self):
        with tempfile.TemporaryDirectory() as root, patch.object(main, "UPLOAD_ROOT", Path(root)), patch.dict(os.environ, {"AUTH_TOKEN": "audit-token"}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://parser") as client:
                response = await client.post('/parse-execute',
                    headers={"Authorization": "Bearer audit-token"},
                    files={"file": ("fixture.txt", "这是可检索的正常文档内容。".encode(), "text/plain")},
                    data={"ocr_api_key": "private-fixture-key"})
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertEqual(result['status'], 'completed')
                self.assertIn('正常文档', result['markdown'])
                self.assertNotIn('private-fixture-key', response.text)
                self.assertNotIn(result['task_id'], main.tasks)
                self.assertEqual(list(Path(root).iterdir()), [])

    async def test_execution_requires_auth(self):
        with patch.dict(os.environ, {"AUTH_TOKEN": "audit-token"}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://parser") as client:
                response = await client.post('/parse-execute', files={"file": ("fixture.txt", b"hello")})
                self.assertEqual(response.status_code, 401)
