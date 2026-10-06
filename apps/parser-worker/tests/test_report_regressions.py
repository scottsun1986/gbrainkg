"""Offline proofs for parser contract, security and upload cleanup findings."""
import asyncio
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import UploadFile, BackgroundTasks, HTTPException
import main
from controlled_jobs import FairLimiter
from env_config import env_int, env_float


class ReportRegressions(unittest.IsolatedAsyncioTestCase):
    async def test_execute_preserves_identity_and_ocr_fields(self):
        captured = {}
        async def process(task_id, path, parser_type, config):
            captured.update(identity=main.tasks[task_id]['instanceId'], config=config)
            main.tasks[task_id].update(status='completed', markdown='content')
            main.safe_unlink(path)
        with tempfile.TemporaryDirectory() as root, patch.object(main, 'UPLOAD_ROOT', Path(root)), patch.object(main, 'process_file', process):
            result = await main.execute_document(file=UploadFile(filename='test.txt', file=io.BytesIO(b'content')), instance_id='inst2', ocr_provider='baidu', ocr_endpoint='https://aip.baidubce.com', ocr_api_key='key', ocr_secret_key='secret', _auth=None)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(captured, {'identity': 'inst2', 'config': {'provider': 'baidu', 'endpoint': 'https://aip.baidubce.com', 'api_key': 'key', 'secret_key': 'secret'}})

    async def test_cancelled_upload_removes_task_and_partial_file(self):
        upload = UploadFile(filename='test.txt', file=io.BytesIO())
        upload.read = AsyncMock(side_effect=[b'partial', asyncio.CancelledError()])
        before = set(main.tasks)
        with tempfile.TemporaryDirectory() as root, patch.object(main, 'UPLOAD_ROOT', Path(root)):
            with self.assertRaises(asyncio.CancelledError):
                await main.parse_document(BackgroundTasks(), file=upload, instance_id='inst1', _auth=None)
            self.assertEqual(list(Path(root).iterdir()), [])
        self.assertEqual(set(main.tasks), before)

    async def test_metrics_and_vpc_require_configured_token(self):
        with patch.dict(os.environ, {'AUTH_TOKEN': '', 'PARSER_ALLOW_UNAUTHENTICATED_LOOPBACK': '0'}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, client=('172.16.1.2', 123)), base_url='http://parser') as client:
                self.assertEqual((await client.get('/metrics')).status_code, 401)
                self.assertEqual((await client.get('/health')).status_code, 200)

    async def test_oversized_embedded_upload_keeps_413(self):
        with tempfile.TemporaryDirectory() as root, patch.object(main, 'UPLOAD_ROOT', Path(root)), patch.object(main, 'OCR_MAX_FILE_BYTES', 2):
            with self.assertRaises(HTTPException) as result:
                await main.ocr_embedded_images_endpoint(file=UploadFile(filename='test.docx', file=io.BytesIO(b'over')), instance_id='inst1', _auth=None)
            self.assertEqual(result.exception.status_code, 413)
            self.assertEqual(list(Path(root).iterdir()), [])

    async def test_limiter_drops_finished_identity(self):
        limiter = FairLimiter(1)
        async with limiter.slot('temporary-instance'):
            pass
        self.assertEqual(limiter.running, {})

    async def test_invalid_artifact_url_never_fetched(self):
        client = AsyncMock()
        for url in ['http://169.254.169.254/latest', 'https://127.0.0.1/a', 'https://example.com/a']:
            with self.assertRaises(RuntimeError):
                await main.download_ocr_markdown(client, url)
        client.stream.assert_not_called()

    def test_invalid_numbers_use_defaults(self):
        for invalid in ['', 'NaN', '10m', '-1']:
            with patch.dict(os.environ, {'TEST_NUMBER': invalid}):
                self.assertEqual(env_int('TEST_NUMBER', 4), 4)
                self.assertEqual(env_float('TEST_NUMBER', 4), 4)
