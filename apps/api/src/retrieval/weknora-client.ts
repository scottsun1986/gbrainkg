/** Read-only trial client for the official WeKnora knowledge-search API.
 * No WeKnora database access, vendored parser, schema patches, or auto-indexing.
 * Input bindings must come from the application's current ACL/version resolver.
 */
export interface WeKnoraBinding {
  knowledgeId: string;
  documentId: string;
  kbId: string;
  version: number;
}
export interface RetrievedEvidence {
  provider: 'weknora';
  externalChunkId: string;
  documentId: string;
  kbId: string;
  documentVersion: number;
  content: string;
  score: number;
}

export class WeKnoraClient {
  private readonly endpoint: string;
  constructor(private readonly config: { baseUrl: string; apiKey: string; timeoutMs?: number }) {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('WEKNORA_INVALID_ENDPOINT');
    if (!config.apiKey.trim()) throw new Error('WEKNORA_MISSING_CREDENTIAL');
    this.endpoint = `${url.toString().replace(/\/$/, '')}/api/v1/knowledge-search`;
  }

  async search(query: string, bindings: WeKnoraBinding[], signal?: AbortSignal): Promise<RetrievedEvidence[]> {
    signal?.throwIfAborted();
    if (!bindings.length || !query.trim()) return [];
    const allowed = new Map(bindings.map(binding => [binding.knowledgeId, binding]));
    if (allowed.size !== bindings.length || bindings.some(b => !b.knowledgeId || !b.documentId || !b.kbId || !Number.isInteger(b.version) || b.version < 1)) throw new Error('WEKNORA_INVALID_BINDINGS');
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('WEKNORA_INVALID_TIMEOUT');
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
      body: JSON.stringify({ query, knowledge_ids: [...allowed.keys()] }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`WEKNORA_HTTP_${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('WEKNORA_EMPTY_RESPONSE');
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('WEKNORA_RESPONSE_LIMIT');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let payload: any;
    try { payload = JSON.parse(text); } catch { throw new Error('WEKNORA_INVALID_JSON'); }
    if (payload?.success !== true || !Array.isArray(payload.data)) throw new Error('WEKNORA_INVALID_SCHEMA');
    const evidence: RetrievedEvidence[] = [];
    for (const row of payload.data) {
      const binding = allowed.get(row?.knowledge_id);
      // Even if an upstream key has broader access, unknown documents cannot
      // enter this application's evidence set.
      if (!binding) continue;
      if (typeof row.id !== 'string' || !row.id || typeof row.content !== 'string' || typeof row.score !== 'number' || !Number.isFinite(row.score)) throw new Error('WEKNORA_INVALID_SCHEMA');
      evidence.push({ provider: 'weknora', externalChunkId: row.id, documentId: binding.documentId,
        kbId: binding.kbId, documentVersion: binding.version, content: row.content, score: row.score });
    }
    return evidence;
  }
}
