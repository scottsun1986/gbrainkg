import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from controlled_jobs import FairLimiter, run_process

class ControlledJobsTest(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_reaps_process(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "pid"
            command = [sys.executable, "-c", "import os,sys,time;open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(30)", str(pid_file)]
            with self.assertRaises(asyncio.TimeoutError):
                await run_process(command, .3)
            pid = int(pid_file.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    async def test_round_robin_prevents_instance_starvation(self):
        limiter = FairLimiter(1, per_instance=1)
        order = []
        release = asyncio.Event()
        async def run(identity, name, blocked=False):
            async with limiter.slot(identity):
                order.append(name)
                if blocked:
                    await release.wait()
        first = asyncio.create_task(run('a', 'a1', True))
        await asyncio.sleep(0)
        jobs = [asyncio.create_task(run('a', 'a2')), asyncio.create_task(run('a', 'a3')), asyncio.create_task(run('b', 'b1'))]
        await asyncio.sleep(0)
        release.set()
        await asyncio.gather(first, *jobs)
        self.assertEqual(order, ['a1', 'a2', 'b1', 'a3'])

    async def test_cancelled_waiter_does_not_lose_capacity(self):
        limiter = FairLimiter(1)
        async with limiter.slot('a'):
            async def wait():
                async with limiter.slot('b'):
                    self.fail('cancelled job ran')
            pending = asyncio.create_task(wait())
            await asyncio.sleep(0)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        async with limiter.slot('c'):
            self.assertEqual(limiter.active, 1)
        self.assertEqual(limiter.active, 0)
