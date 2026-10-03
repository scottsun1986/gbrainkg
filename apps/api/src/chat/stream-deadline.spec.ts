import { StreamDeadline } from './stream-deadline';

describe('answer stream transport deadlines', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('bounds stalled headers or body reads even when the provider ignores cancellation', async () => {
    const stream = new StreamDeadline(undefined, 120000, 45000);
    const pending = stream.wait(() => new Promise(() => {}));
    const result = expect(pending).rejects.toThrow('长时间未响应');
    await jest.advanceTimersByTimeAsync(45000);
    await result;
    expect(stream.signal.aborted).toBe(true);
    stream.dispose(); expect(jest.getTimerCount()).toBe(0);
  });
  it('bounds a provider that keeps sending reasoning or heartbeat bytes', async () => {
    const stream = new StreamDeadline(undefined, 100, 45);
    await stream.wait(async () => 'heartbeat');
    await jest.advanceTimersByTimeAsync(40);
    await stream.wait(async () => 'heartbeat');
    await jest.advanceTimersByTimeAsync(40);
    const pending = stream.wait(() => new Promise(() => {}));
    const result = expect(pending).rejects.toThrow('超过等待时限');
    await jest.advanceTimersByTimeAsync(20); await result;
    stream.dispose(); expect(jest.getTimerCount()).toBe(0);
  });
  it('propagates user or authorization cancellation and releases listeners/timers', async () => {
    const parent = new AbortController();
    const remove = jest.spyOn(parent.signal, 'removeEventListener');
    const stream = new StreamDeadline(parent.signal);
    const pending = stream.wait(() => new Promise(() => {}));
    parent.abort(new Error('authorization changed'));
    await expect(pending).rejects.toThrow('authorization changed');
    stream.dispose(); expect(remove).toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
  it('rejects a request already cancelled before contacting the provider', async () => {
    const parent = new AbortController(); parent.abort(new Error('cancelled'));
    const stream = new StreamDeadline(parent.signal); const work = jest.fn();
    await expect(stream.wait(work)).rejects.toThrow('cancelled'); expect(work).not.toHaveBeenCalled(); stream.dispose();
  });
});
