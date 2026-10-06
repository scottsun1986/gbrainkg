"""Prove report-mode execution failures and prerequisite skips stay distinguishable."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class GateScriptTests(unittest.TestCase):
    def environment(self):
        env = dict(os.environ)
        for key in ('TEST_PASSWORD', 'LLMWIKI_PASS', 'LLMWIKI_TOKEN'):
            env.pop(key, None)
        env.update(GATE_STRICT='0', API_BASE='http://127.0.0.1:1')
        return env

    def test_missing_credentials_are_skip_not_pass(self):
        for script in ('ab-gate.sh', 'feedback-gate.sh'):
            env = self.environment()
            result = subprocess.run(['bash', str(ROOT / 'scripts' / script)], env=env, capture_output=True)
            self.assertEqual(result.returncode, 2, script)
            env['GATE_STRICT'] = '1'
            result = subprocess.run(['bash', str(ROOT / 'scripts' / script)], env=env, capture_output=True)
            self.assertEqual(result.returncode, 1, script)

    def test_runner_crash_is_failure_even_in_report_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            command = Path(directory) / 'npx'
            command.write_text('#!/bin/sh\nexit 73\n')
            command.chmod(0o700)
            env = self.environment()
            env.update(TEST_PASSWORD='test-only', PATH=f"{directory}:{env['PATH']}")
            for script in ('ab-gate.sh', 'feedback-gate.sh'):
                result = subprocess.run(['bash', str(ROOT / 'scripts' / script)], env=env, capture_output=True)
                self.assertEqual(result.returncode, 73, script)


if __name__ == '__main__':
    unittest.main()
