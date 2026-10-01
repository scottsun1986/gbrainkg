import type { Subscriber } from 'rxjs';

/** Batch output to amortize primary DB barriers. Nothing in a rejected batch is emitted. */
export function authorizationOutput<T>(destination: Subscriber<T>, check: () => Promise<void>,
  abort: () => void, intervalMs = 25): Subscriber<T> {
  let pending: T[] = [];
  let ending = false;
  let failed = false;
  let flushing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: unknown) => {
    failed = true;
    pending = [];
    if (timer) clearTimeout(timer);
    abort();
    destination.error(error);
  };
  const schedule = () => {
    if (!timer && !flushing && !failed && !destination.closed) {
      timer = setTimeout(() => { timer = undefined; void flush(); }, intervalMs);
    }
  };
  const flush = async () => {
    if (flushing || failed || destination.closed) return;
    flushing = true;
    try {
      await check();
      if (failed || destination.closed) return;
      const batch = pending;
      pending = [];
      for (const value of batch) {
        if (destination.closed) break;
        destination.next(value);
      }
      if (ending && !pending.length) destination.complete();
    } catch (error) { fail(error); }
    finally { flushing = false; if (pending.length || ending) schedule(); }
  };
  return new Proxy(destination, {
    get(target, property) {
      if (property === 'next') return (value: T) => {
        if (failed || ending || destination.closed) return;
        pending.push(value);
        if (pending.length > 4096) { fail(new Error('Output backpressure limit exceeded')); return; }
        schedule();
      };
      if (property === 'complete') return () => { ending = true; schedule(); };
      if (property === 'error') return fail;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
