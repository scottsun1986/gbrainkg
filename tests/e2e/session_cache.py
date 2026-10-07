"""One in-memory login per endpoint/persona; sessions never persist to disk."""
import asyncio


class SessionCache:
    def __init__(self):
        self._tokens = {}
        self._locks = {}

    def get(self, endpoint, username):
        return self._tokens.get((endpoint, username), "")

    def put(self, endpoint, username, token):
        if token:
            self._tokens[(endpoint, username)] = token

    async def authenticate(self, endpoint, username, login):
        key = (endpoint, username)
        async with self._locks.setdefault(key, asyncio.Lock()):
            cached = self.get(endpoint, username)
            if cached:
                return cached
            token = await login()
            self.put(endpoint, username, token)
            return token
