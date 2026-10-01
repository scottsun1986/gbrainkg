/** Compatible with Node 18; does not require AbortSignal.any(). */
export function combineAbortSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    listeners.push([signal, abort]);
  }
  return { signal: controller.signal, dispose: () => listeners.forEach(([signal, listener]) => signal.removeEventListener('abort', listener)) };
}
