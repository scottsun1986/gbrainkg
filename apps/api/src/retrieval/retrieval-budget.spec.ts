import { Bulkhead, RetrievalDeadline } from './retrieval-budget';

it('does not start work after its budget expires', async () => {
  const deadline = new RetrievalDeadline(0);
  const work = jest.fn(async () => 1);
  expect(await deadline.guard(work, 0)).toBe(0);
  expect(work).not.toHaveBeenCalled();
});
it('aborts work on timeout and retains the resource slot until actual completion', async () => {
  const deadline = new RetrievalDeadline(5);
  const bulkhead = new Bulkhead(1);
  let release!: () => void;
  let signal!: AbortSignal;
  const result = await deadline.guard(s => bulkhead.run(async () => {
    signal = s;
    await new Promise<void>(resolve => { release = resolve; });
    return 1;
  }), 0);
  expect(result).toBe(0);
  expect(signal.aborted).toBe(true);
  expect(bulkhead.running).toBe(1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  expect(bulkhead.running).toBe(0);
});
it('rejects excess queued work without increasing resource usage', async () => {
  const bulkhead = new Bulkhead(1, 0);
  let release!: () => void;
  const first = bulkhead.run(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  await expect(bulkhead.run(async () => 2)).rejects.toThrow(/capacity/);
  release();
  await first;
});
