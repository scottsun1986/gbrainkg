"""Exercise the real service entrypoint without pytest's src sys.path injection."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


class StartupTests(unittest.TestCase):
    def free_port(self):
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        listener.close()
        return port

    def environment(self, directory, flat=False):
        env = os.environ.copy()
        env.pop('PYTHONPATH', None)
        env.pop('PYTHONHOME', None)
        if flat:
            env['PYTHONPATH'] = str(ROOT / 'src')
        env.update({
            'UPLOAD_ROOT': directory,
            'PARSER_ARTIFACT_CACHE': str(Path(directory) / 'cache'),
            'PARSER_STREAM_ARTIFACT_ROOT': str(Path(directory) / 'streams'),
            'AUTH_TOKEN': '',
            'LOCAL_DOCLING_ENABLED': '0',
            'OCR_PROVIDER': 'none',
        })
        return env

    def free_port(self):
        """Reserve a free loopback port; SO_REUSEADDR avoids TIME_WAIT reuse."""
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        listener.close()
        return port

    def start(self, command, directory, flat=False):
        """Start a server on a fresh port and return (child, port, log)."""
        port = self.free_port()
        log = tempfile.TemporaryFile(mode='w+')
        child = subprocess.Popen(command(port), cwd=ROOT,
                                 env=self.environment(directory, flat),
                                 stdout=log, stderr=subprocess.STDOUT)
        return child, port, log

    def await_health(self, child, port, log):
        """Poll /health until the server answers, then reap the child."""
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and child.poll() is None:
                try:
                    with urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                        self.assertEqual(response.status, 200)
                        self.assertIsInstance(json.load(response), dict)
                    return
                except (URLError, TimeoutError, ConnectionError):
                    time.sleep(0.05)
            log.seek(0)
            self.fail(f'service failed to start: {log.read()}')
        finally:
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
            log.close()

    def run_service_case(self, command, flat=False):
        with tempfile.TemporaryDirectory() as directory:
            child, port, log = self.start(command, directory, flat)
            self.await_health(child, port, log)

    def test_uvicorn_package_and_flat_entrypoints(self):
        # `python -m src.main` sets __package__ and puts the worker root on
        # sys.path, so its __main__ block must reference src.main:app, while a
        # plain script run must reference main:app. A hardcoded "main:app" broke
        # the first mode with "Could not import module main".
        cases = [
            ('uvicorn src.main:app', lambda port: [sys.executable, '-m', 'uvicorn', 'src.main:app',
                                                   '--host', '127.0.0.1', '--port', str(port)], False),
            ('uvicorn main:app', lambda port: [sys.executable, '-m', 'uvicorn', 'main:app',
                                               '--host', '127.0.0.1', '--port', str(port)], True),
            ('python -m src.main', lambda port: [sys.executable, '-m', 'src.main',
                                                 '--host', '127.0.0.1', '--port', str(port)], False),
        ]
        for label, command, flat in cases:
            with self.subTest(entrypoint=label):
                self.run_service_case(command, flat)

    def test_native_job_script_and_package_execution(self):
        commands = [[str(ROOT / 'src/native_job.py')], ['-m', 'src.native_job']]
        for command in commands:
            with self.subTest(command=command), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'fixture.txt'
                source.write_text('Import regression native plaintext fixture.', encoding='utf-8')
                output = Path(directory) / 'output'
                output.mkdir()
                result = subprocess.run(
                    [sys.executable, *command, 'plaintext', str(source), str(output), '{}'],
                    cwd=ROOT, env=self.environment(directory), capture_output=True,
                    text=True, timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('Import regression', json.loads((output / 'result.json').read_text())['markdown'])

    def test_local_module_state_is_shared_in_both_import_modes(self):
        # Mixing src.artifact_cache and artifact_cache splits tenant ContextVars.
        for flat, prefix in [(False, 'src.'), (True, '')]:
            with self.subTest(prefix=prefix), tempfile.TemporaryDirectory() as directory:
                probe = f'''
import importlib
main = importlib.import_module({prefix + "main"!r})
cache = importlib.import_module({prefix + "artifact_cache"!r})
excel = importlib.import_module({prefix + "structured_excel"!r})
batches = importlib.import_module({prefix + "table_batches"!r})
assert main.artifact_cache is cache
assert excel.artifact_cache is cache
assert batches.artifact_cache is cache
for name in ('native_job', 'structured_job', 'office_job', 'docling_job'):
    importlib.import_module({prefix!r} + name)
'''
                result = subprocess.run([sys.executable, '-c', probe], cwd=ROOT,
                                        env=self.environment(directory, flat),
                                        capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
