import { ChatTiming, getChatTiming } from './chat-timing';
import { runWithRequestContext } from './request-context';

describe('chat timing', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000); });
  afterEach(() => jest.useRealTimers());
  it('unions overlapping authorization spans instead of inflating their duration', () => {
    const timing = new ChatTiming();
    timing.start('outer', 'authorization'); jest.advanceTimersByTime(10);
    timing.start('inner', 'authorization'); jest.advanceTimersByTime(20);
    timing.finish('inner'); jest.advanceTimersByTime(10); timing.finish('outer');
    expect(timing.snapshot().phases.authorization).toEqual({ durationMs: 40, spans: 2, firstStartedMs: 0, lastFinishedMs: 40 });
  });
  it('keeps provider, prepared, transport and completion milestones distinct', () => {
    const timing = new ChatTiming();
    jest.advanceTimersByTime(10); timing.mark('providerFirstText');
    jest.advanceTimersByTime(20); timing.mark('answerPrepared');
    jest.advanceTimersByTime(70); timing.mark('transportFirstText');
    jest.advanceTimersByTime(5); timing.mark('transportComplete'); timing.mark('providerFirstText');
    expect(timing.snapshot().milestonesMs).toEqual({ providerFirstText: 10, answerPrepared: 30, transportFirstText: 100, transportComplete: 105 });
  });
  it('records user-visible milestones as their own latency metrics (F08)', () => {
    const { metricsRegistry } = require('./metrics.service');
    const timing = new ChatTiming();
    jest.advanceTimersByTime(10); timing.mark('providerFirstText');
    jest.advanceTimersByTime(90); timing.mark('transportFirstText');
    jest.advanceTimersByTime(50); timing.mark('transportComplete');
    const rendered = metricsRegistry.render();
    // User-visible first text and full-answer completion are both measured;
    // the provider's first token is not a substitute for either.
    expect(rendered).toContain('chat_first_text_ms');
    expect(rendered).toContain('chat_user_complete_ms');
  });
  it('shares one timing ledger across copied authorization contexts', () => {
    runWithRequestContext({ requestId: 'timing', startedAt: 1000 }, () => {
      const ledger = getChatTiming();
      runWithRequestContext({ requestId: 'nested', chatTiming: ledger }, () => expect(getChatTiming()).toBe(ledger));
    });
  });
});
