import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import artifact_cache as cache

class ArtifactCacheTest(unittest.TestCase):
    def test_instance_and_revision_separation(self):
        token = cache.instance_identity.set('inst1')
        try:
            first = cache.key(b'page', {'revision': 'v1'})
            self.assertNotEqual(first, cache.key(b'page', {'revision': 'v2'}))
            cache.instance_identity.set('inst2')
            self.assertNotEqual(first, cache.key(b'page', {'revision': 'v1'}))
        finally:
            cache.instance_identity.reset(token)

    def test_expiry_and_capacity(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cache, 'ROOT', Path(directory)), patch.object(cache, 'MAX_BYTES', 30), patch.object(cache, 'TTL_SECONDS', .02):
            cache.write('one', {'page': 'a' * 8})
            self.assertIsNotNone(cache.read('one'))
            cache.write('two', {'page': 'b' * 8})
            self.assertIsNone(cache.read('one'))
            time.sleep(.03)
            self.assertIsNone(cache.read('two'))

    def test_disk_failure_does_not_break_parsing(self):
        with patch.object(Path, 'mkdir', side_effect=OSError('read only')):
            cache.write('x', {'valid': 'parse'})
