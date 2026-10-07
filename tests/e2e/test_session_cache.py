import asyncio
import unittest
from session_cache import SessionCache


class SessionCacheTest(unittest.IsolatedAsyncioTestCase):
    async def test_parallel_api_and_ui_personas_reuse_one_authentication(self):
        cache = SessionCache()
        calls = []
        async def login():
            calls.append(1)
            await asyncio.sleep(0)
            return 'opaque-token'
        values = await asyncio.gather(*(cache.authenticate('local', 'reader', login) for _ in range(8)))
        self.assertEqual(values, ['opaque-token'] * 8)
        self.assertEqual(len(calls), 1)
        self.assertEqual(cache.get('local', 'reader'), 'opaque-token')
        self.assertEqual(cache.get('other-instance', 'reader'), '')
        self.assertEqual(cache.get('local', 'other-persona'), '')

    async def test_failed_login_is_not_cached(self):
        cache = SessionCache()
        async def failed(): return ''
        async def valid(): return 'valid'
        self.assertEqual(await cache.authenticate('local', 'reader', failed), '')
        self.assertEqual(await cache.authenticate('local', 'reader', valid), 'valid')
