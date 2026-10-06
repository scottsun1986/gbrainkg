"""Offline regression for the functional SSE client; no model/API calls."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('full_functional_suite', Path(__file__).with_name('full_functional_suite.py'))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


class FunctionalHarnessTests(unittest.TestCase):
    def chat_events(self, events):
        stream = io.BytesIO(b''.join(b'data: ' + json.dumps(event).encode() + b'\n\n' for event in events))
        with patch.object(suite.urllib.request, 'urlopen', return_value=stream):
            return suite.chat('fake-token', 'fixture question')

    def test_replace_replaces_provisional_delta(self):
        status, result = self.chat_events([{'type': 'delta', 'content': 'provisional'}, {'type': 'replace', 'content': 'final answer'}, {'type': 'done'}])
        self.assertEqual(status, 200)
        self.assertEqual(result['answer'], 'final answer')
        self.assertTrue(result['done'])

    def test_error_never_reports_success(self):
        status, result = self.chat_events([{'type': 'delta', 'content': 'partial'}, {'type': 'error', 'message': 'model failure'}, {'type': 'done'}])
        self.assertEqual(status, 0)
        self.assertFalse(result['done'])
        self.assertEqual(result['error'], 'model failure')

    def test_empty_done_is_not_success(self):
        _, result = self.chat_events([{'type': 'done'}])
        self.assertFalse(result['done'])


if __name__ == '__main__':
    unittest.main()
