"""Bounded shared-service scheduling and cancellation that actually reaps work."""
import asyncio
import os
import signal
from collections import deque
from contextlib import asynccontextmanager

class FairLimiter:
    def __init__(self, capacity: int, queue_limit: int = 64, per_instance: int = 2):
        self.capacity = max(1, capacity)
        self.queue_limit = max(1, queue_limit)
        self.per_instance = max(1, per_instance)
        self.active = 0
        self.running: dict[str, int] = {}
        self.queues: dict[str, deque] = {}
        self.order: deque = deque()

    def _dispatch(self):
        visits = len(self.order)
        while self.active < self.capacity and self.order and visits:
            identity = self.order.popleft()
            queue = self.queues[identity]
            while queue and queue[0].cancelled():
                queue.popleft()
            if queue and self.running.get(identity, 0) < self.per_instance:
                future = queue.popleft()
                self.active += 1
                self.running[identity] = self.running.get(identity, 0) + 1
                future.set_result(None)
                visits = len(self.order) + 1
            else:
                visits -= 1
            if queue:
                self.order.append(identity)
            else:
                self.queues.pop(identity, None)

    @asynccontextmanager
    async def slot(self, identity: str):
        if sum(len(queue) for queue in self.queues.values()) >= self.queue_limit:
            raise RuntimeError("Parser queue capacity exhausted; retry later")
        future = asyncio.get_running_loop().create_future()
        if identity not in self.queues:
            self.queues[identity] = deque()
            self.order.append(identity)
        self.queues[identity].append(future)
        self._dispatch()
        acquired = False
        try:
            await future
            acquired = True
            yield
        finally:
            # Cancellation after a grant but before resuming must release it.
            if acquired or (future.done() and not future.cancelled()):
                self.active -= 1
                self.running[identity] -= 1
                if not self.running[identity]:
                    self.running.pop(identity, None)
            else:
                future.cancel()
            self._dispatch()

async def run_process(argv: list[str], timeout: float):
    process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    try:
        await asyncio.wait_for(process.wait(), timeout)
        if process.returncode:
            raise RuntimeError(f"Parser subprocess exited with code {process.returncode}")
    finally:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            async def reap():
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except asyncio.TimeoutError:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    await process.wait()
            cleanup = asyncio.create_task(reap())
            cancelled = False
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    cancelled = True
            await cleanup
            if cancelled:
                raise asyncio.CancelledError
