import { combineAbortSignals } from '../retrieval/abort-signal';

/** Own transport lifetime, including headers and body, independently of retrieval. */
export class StreamDeadline {
  private readonly controller = new AbortController();
  private readonly combined: ReturnType<typeof combineAbortSignals>;
  private readonly totalTimer: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;

  constructor(parent?: AbortSignal, totalMs = 120000, private readonly idleMs = 45000) {
    this.combined = combineAbortSignals([parent, this.controller.signal]);
    this.signal = this.combined.signal;
    this.totalTimer = setTimeout(() => this.controller.abort(new Error('回答生成超过等待时限，请重试。')), totalMs);
    this.totalTimer.unref?.();
  }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.signal.reason;
    this.idleTimer = setTimeout(() => this.controller.abort(new Error('回答服务长时间未响应，请重试。')), this.idleMs);
    this.idleTimer.unref?.();
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try { return await Promise.race([operation(), aborted]); }
    finally { clearTimeout(this.idleTimer); this.signal.removeEventListener('abort', rejectAbort); }
  }

  dispose() { clearTimeout(this.totalTimer); clearTimeout(this.idleTimer); this.combined.dispose(); }
}
