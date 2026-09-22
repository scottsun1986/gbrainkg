/**
 * Query-time resource guards for the retrieval fan-out.
 *
 * The audit flagged that a single request can fan out to the primary query,
 * several sub-queries, GraphRAG, RAPTOR and WeKnora with no shared deadline and
 * no global concurrency limit. Under load that turns one slow store into
 * unbounded queue growth on the database and the LLM gateway.
 *
 * `RetrievalDeadline` gives every arm the same wall-clock budget, and
 * `Bulkhead` caps the number of simultaneously running database-backed arms so
 * a burst of requests queues in the application instead of on PostgreSQL.
 */

export class RetrievalDeadline {
  private readonly startedAt = Date.now();

  constructor(private readonly totalMs: number) {}

  /** Milliseconds left before the whole retrieval pass must give up. */
  remainingMs(): number {
    return Math.max(0, this.totalMs - (Date.now() - this.startedAt));
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** Budget for one arm: never more than the remaining global budget. */
  slice(capMs: number): number {
    return Math.max(1, Math.min(capMs, this.remainingMs() || 1));
  }

  /**
   * Resolve with the promise result, or with `fallback` when the deadline
   * passes first. Retrieval prefers a partial answer over a hung request.
   */
  async guard<T>(promise: Promise<T>, fallback: T, label?: string): Promise<T> {
    const budget = this.remainingMs();
    if (budget <= 0) return fallback;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise.catch(() => fallback),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), budget);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Simple FIFO semaphore: bounds concurrent database-backed work. */
export class Bulkhead {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number, private readonly queueLimit = Number(process.env.RETRIEVAL_QUEUE_LIMIT || 200)) {}

  get pending(): number {
    return this.waiting.length;
  }

  get running(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Non-blocking variant: returns `fallback` immediately when the bulkhead is
   * saturated, which is the behaviour wanted on the answer path (degrade the
   * arm rather than queue the user behind an unbounded backlog).
   */
  async runOrFallback<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    // Shed immediately when the bulkhead is saturated or the queue is long:
    // the answer path degrades one arm instead of queueing the user behind an
    // unbounded backlog.
    if (this.active >= this.limit || this.waiting.length >= this.queueLimit) return fallback;
    return this.run(fn);
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}
