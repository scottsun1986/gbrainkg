import { admitModelCall } from './model-admission';
import { createHash } from 'node:crypto';
import { getRequestContext } from '../observability/request-context';
import { assertRequestAuthorization } from '../permission/authorization-revision';
import { requestSignal } from './request-signal';
import { currentQueryExecution } from './query-execution';

const requests = new WeakMap<object, Map<string, Promise<number | null>>>();
type Config = { modelName: string; provider: { baseUrl: string; apiKey?: string } };

/** Exact pair scores are memoized within one request; partial/malformed responses aren't fabricated. */
export async function rerankPairs(config: Config, query: string, documents: string[], timeoutMs: number) {
  const ctx = getRequestContext();
  const execution = currentQueryExecution();
  const cache = ctx ? (requests.get(ctx) ?? new Map<string, Promise<number | null>>()) : new Map<string, Promise<number | null>>();
  if (ctx) requests.set(ctx, cache);
  const fingerprint = JSON.stringify([config.provider.baseUrl, config.modelName, process.env.RERANK_DEPLOYMENT_REVISION || 'unversioned']);
  const keys = documents.map(doc => createHash('sha256').update(JSON.stringify([fingerprint, query, doc])).digest('hex'));
  const fresh: Array<{ key: string; doc: string; resolve: (value: number | null) => void }> = [];
  for (let i = 0; i < keys.length; i++) {
    if (cache.has(keys[i])) continue;
    if (execution?.adaptive && !execution.reservePairs(1)) continue;
    let resolve!: (value: number | null) => void;
    cache.set(keys[i], new Promise(done => { resolve = done; }));
    fresh.push({ key: keys[i], doc: documents[i], resolve });
  }
  if (fresh.length) {
    const cancellation = requestSignal(timeoutMs);
    try {
      if (cancellation.signal.aborted) throw cancellation.signal.reason;
      await assertRequestAuthorization();
      await admitModelCall(config.provider.baseUrl,config.modelName,Math.ceil((query.length + fresh.reduce((sum,pair) => sum+pair.doc.length,0))/3));
      const response = await fetch(`${config.provider.baseUrl.replace(/\/$/, '')}/rerank`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.provider.apiKey ? { Authorization: `Bearer ${config.provider.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.modelName, query, documents: fresh.map(pair => pair.doc), top_n: fresh.length, return_documents: false }), signal: cancellation.signal,
      });
      if (!response.ok) throw new Error(`Rerank API ${response.status}`);
      const payload: any = await response.json();
      execution?.recordUsage(payload?.usage);
      const scores = new Map<number, number>();
      for (const row of payload?.results || []) {
        const value = Number(row.relevance_score ?? row.score);
        if (Number.isInteger(row.index) && row.index >= 0 && row.index < fresh.length && Number.isFinite(value)) scores.set(row.index, value);
      }
      fresh.forEach((pair, i) => pair.resolve(scores.get(i) ?? null));
    } catch (error) { fresh.forEach(pair => pair.resolve(null)); throw error; }
    finally { cancellation.dispose(); }
  }
  const scores = await Promise.all(keys.map(key => cache.get(key) ?? Promise.resolve(null)));
  return scores.flatMap((relevance_score, index) => relevance_score === null ? [] : [{ index, relevance_score }]);
}
