"""Authentication, identity, expiry and actual disk-budget regression proofs."""
import asyncio
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import main
import temp_budget

artifact_store = main.artifact_store


class StreamArtifactTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patcher = patch.object(artifact_store, 'ROOT', self.root / 'streams')
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    async def test_download_is_authenticated_instance_scoped_binary_or_jsonl(self):
        writer = artifact_store.Writer('inst1')
        writer.write({'row': 1, 'cells': [{'column': 4, 'value': 0}]})
        identifier = writer.finish()
        image = artifact_store.publish_blob(b'raw-image-bytes', 'inst1', 'image/png')
        with patch.dict(os.environ, {'AUTH_TOKEN': 'worker-token'}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://worker') as client:
                self.assertEqual((await client.get(f'/artifacts/{identifier}?instance_id=inst1')).status_code, 401)
                headers = {'Authorization': 'Bearer worker-token'}
                denied = await client.get(f'/artifacts/{identifier}?instance_id=inst2', headers=headers)
                self.assertEqual(denied.status_code, 404)
                allowed = await client.get(f'/artifacts/{identifier}?instance_id=inst1', headers=headers)
                self.assertEqual(allowed.status_code, 200)
                self.assertEqual(json.loads(allowed.text)['cells'][0]['value'], 0)
                self.assertEqual(allowed.headers['content-type'], 'application/x-ndjson')
                self.assertEqual(allowed.headers['cache-control'], 'private, no-store')
                binary = await client.get(f'/artifacts/{image}?instance_id=inst1', headers=headers)
                self.assertEqual(binary.content, b'raw-image-bytes')
                self.assertEqual(binary.headers['content-type'], 'image/png')
        self.assertIsNone(artifact_store.resolve('../outside', 'inst1'))

    def test_expired_and_oversized_artifacts_are_not_served(self):
        writer = artifact_store.Writer('inst1')
        writer.write({'row': 1})
        identifier = writer.finish()
        with patch.object(artifact_store, 'TTL_SECONDS', 1), patch.object(artifact_store.time, 'time', return_value=artifact_store.time.time() + 2):
            self.assertIsNone(artifact_store.resolve(identifier, 'inst1'))
        writer = artifact_store.Writer('inst1')
        with patch.object(artifact_store, 'MAX_ARTIFACT_BYTES', 2):
            with self.assertRaisesRegex(ValueError, 'output budget'):
                writer.write({'row': 1})
        writer.abort()
        self.assertFalse(list(artifact_store.ROOT.glob('*.pending')))

    def test_actual_temp_budget_includes_native_outputs_and_cleans_partial(self):
        output = self.root / 'uploads'
        output.mkdir()
        (output / 'existing').write_bytes(b'x' * 7)
        native = output / 'native'
        native.mkdir()
        (native / 'blob').write_bytes(b'x' * 7)
        with patch.dict(os.environ, {'PARSER_MAX_TEMP_BYTES': '20'}):
            with (output / 'new').open('wb') as handle:
                with self.assertRaisesRegex(ValueError, 'temporary byte budget'):
                    temp_budget.write(handle, b'x' * 7, output)
        self.assertEqual((output / 'new').stat().st_size, 0)

    def test_buffered_writers_share_actual_byte_limit_at_flush(self):
        first = artifact_store.Writer('inst1')
        second = artifact_store.Writer('inst2')
        row = {'row': 1, 'value': '原始事实'}
        try:
            for _ in range(20):
                first.write(row)
            self.assertEqual(first.path.stat().st_size, 0)
            first_id = first.finish()
            path = artifact_store.resolve(first_id, 'inst1')
            self.assertEqual(len(path.read_text(encoding='utf-8').splitlines()), 20)
            second.write(row)
            with patch.object(artifact_store, 'MAX_BYTES', path.stat().st_size + second.buffer_size - 1):
                with self.assertRaisesRegex(ValueError, 'disk budget'):
                    second.finish()
                self.assertEqual(second.path.stat().st_size, 0)
            self.assertFalse((artifact_store.ROOT / (second.id + '.meta')).exists())
        finally:
            first.abort()
            second.abort()

    def test_retention_counts_asset_metadata_and_inline_budget_spills(self):
        task = {'status': 'completed', 'created_at': 1, 'markdown': 'body',
                'assets': [{'data_base64': 'x' * 1000}]}
        self.assertGreater(main.retained_result_bytes(task), 1000)
        with patch.object(main, 'tasks', {'old': task, 'current': {'status': 'completed', 'created_at': 2, 'markdown': 'body'}}), patch.object(main, 'MAX_RETAINED_BYTES', 200):
            main.account_retained_result('current')
            self.assertNotIn('old', main.tasks)
            self.assertNotIn('_retained_bytes', main.public_task_result(main.tasks['current']))
        contract = main.source_contract
        inline = contract.inline_asset_bytes.set(0)
        assets = contract.asset_artifacts.set({})
        try:
            with patch.object(contract, 'MAX_INLINE_ASSET_BYTES', 10):
                first = contract.asset({'key': 'a', 'blob': b'large-for-budget', 'ext': 'png'}, 'inst1')
                second = contract.asset({'key': 'b', 'blob': b'large-for-budget', 'ext': 'png'}, 'inst1')
            self.assertNotIn('data_base64', first)
            self.assertEqual(first['artifact_id'], second['artifact_id'])
        finally:
            contract.inline_asset_bytes.reset(inline)
            contract.asset_artifacts.reset(assets)

    async def test_native_cancellation_reaps_process_and_removes_spilled_files(self):
        # Use the real runner, substituting only the child command. Verify that
        # cancellation returns after the process is reaped and spill removed.
        source = self.root / 'source.txt'
        source.write_text('body')
        real_runner = main.run_process
        pid_file = self.root / 'pid'
        async def blocked_runner(argv, timeout):
            import sys
            code = 'import os,sys,time;open(sys.argv[1],"w").write(str(os.getpid()));time.sleep(30)'
            await real_runner([sys.executable, '-c', code, str(pid_file)], timeout)
        with patch.object(main, 'UPLOAD_ROOT', self.root), patch.object(main, 'run_process', blocked_runner):
            task = asyncio.create_task(main.native_extract('image', source))
            for _ in range(100):
                if pid_file.exists():
                    break
                await asyncio.sleep(.01)
            self.assertTrue(pid_file.exists())
            pid = int(pid_file.read_text())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            self.assertFalse(list(self.root.glob('source-native-*')))
