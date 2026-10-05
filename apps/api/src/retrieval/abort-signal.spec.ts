import { combineAbortSignals } from './abort-signal';

describe('engine stage cancellation', () => {
  it('bounds a raced engine stage with its independent hard timeout', () => {
    const request = new AbortController();
    const hardLimit = new AbortController();
    const race = new AbortController();
    const stage = combineAbortSignals([request.signal, hardLimit.signal, race.signal]);
    const reason = new Error('Engine hard timeout');
    hardLimit.abort(reason);
    expect(stage.signal.aborted).toBe(true);
    expect(stage.signal.reason).toBe(reason);
    expect(request.signal.aborted).toBe(false);
    stage.dispose();
  });

  it('does not poison the request or later stages when the race is lost', () => {
    const request = new AbortController();
    const hardLimit = new AbortController();
    const race = new AbortController();
    const stage = combineAbortSignals([request.signal, hardLimit.signal, race.signal]);
    race.abort();
    expect(stage.signal.aborted).toBe(true);
    expect(request.signal.aborted).toBe(false);
    expect(hardLimit.signal.aborted).toBe(false);
    stage.dispose();
    const later = combineAbortSignals([request.signal, hardLimit.signal]);
    expect(later.signal.aborted).toBe(false);
    later.dispose();
  });

  it('honors a hard timeout that elapsed before the stage started', () => {
    const hardLimit = new AbortController();
    hardLimit.abort();
    const stage = combineAbortSignals([hardLimit.signal]);
    expect(stage.signal.aborted).toBe(true);
    stage.dispose();
  });
});
