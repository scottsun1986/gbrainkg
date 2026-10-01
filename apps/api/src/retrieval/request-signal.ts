import { admitModelCall } from './model-admission';
import { getRequestContext } from '../observability/request-context';
import { combineAbortSignals } from './abort-signal';

/** Fetch calls release listeners after the body has been read, not just headers. */
export function requestSignal(timeoutMs: number, callerSignal?: AbortSignal | null) {
  const execution = getRequestContext()?.execution;
  const deadline = execution?.retrievalComplete ? undefined : execution?.deadline;
  return combineAbortSignals([callerSignal || undefined, deadline?.signal, getRequestContext()?.cancellation,
    AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline?.remainingMs() ?? timeoutMs)))]);
}

export async function requestFetch(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const cancellation = requestSignal(timeoutMs, init.signal);
  try {
    let model: string | undefined;
    if (typeof init.body === 'string') { try { model=JSON.parse(init.body)?.model; } catch {} }
    if (cancellation.signal.aborted) throw cancellation.signal.reason;
    if (model) await admitModelCall(input,model,Math.ceil(String(init.body).length/3));
    if (cancellation.signal.aborted) throw cancellation.signal.reason;
    const response = await fetch(input, { ...init, signal: cancellation.signal });
    if (!response.ok) { cancellation.dispose(); return response; }
    for (const method of ['json', 'text', 'arrayBuffer'] as const) {
      if (typeof response[method] !== 'function') continue;
      const read = response[method].bind(response);
      (response as any)[method] = async () => { try { const result=await read(); if (method === 'json') getRequestContext()?.execution?.recordUsage(result?.usage); return result; } finally { cancellation.dispose(); } };
    }
    cancellation.signal.addEventListener('abort', cancellation.dispose, { once: true });
    return response;
  } catch (error) { cancellation.dispose(); throw error; }
}
