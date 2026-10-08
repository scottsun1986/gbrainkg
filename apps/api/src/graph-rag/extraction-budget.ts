/** One budget contract for ingestion, rebuilds and incremental projections. */
export function resolveGraphLlmExtraction(
  env: NodeJS.ProcessEnv = process.env,
): { sampleRate: number; maxLlmChunks: number } {
  // Full mode overrides stale sampling settings, within the explicit safety cap.
  if (env.GRAPH_LLM_FULL_EXTRACTION === '1') return { sampleRate: 1, maxLlmChunks: 100000 };
  const rate = Number(env.GRAPH_LLM_SAMPLE_RATE ?? 0.6);
  const max = Number(env.GRAPH_LLM_MAX_CHUNKS ?? 60);
  return {
    sampleRate: Number.isFinite(rate) && rate > 0 ? Math.min(rate, 1) : 0.6,
    maxLlmChunks: Number.isFinite(max) && max >= 1 ? Math.min(Math.floor(max), 100000) : 60,
  };
}

export function graphDocumentChunkLimit(env: NodeJS.ProcessEnv = process.env): number {
  if (env.GRAPH_LLM_FULL_EXTRACTION === '1') return 100000;
  const value = Number(env.AUTO_GRAPH_EXTRACT_MAX_CHUNKS ?? 200);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 100000) : 200;
}

/** Spread a bounded extraction across the complete document, including its tail. */
export function selectGraphExtractionChunks<T>(chunks: T[], limit: number): Array<{ chunk: T; idx: number }> {
  const count = Math.max(0, Math.min(chunks.length, Math.floor(limit)));
  return Array.from({ length: count }, (_, index) => {
    const idx = count === 1 ? 0 : Math.round(index * (chunks.length - 1) / (count - 1));
    return { chunk: chunks[idx], idx };
  });
}

/** Half the budget preserves coverage; the remainder resolves observed uncertainty. */
export function allocateGraphExtractionChunks<T>(
  chunks: T[], sampleRate: number, cap: number, priorities: number[],
): Array<{ chunk: T; idx: number }> {
  const maximum = Math.max(0, Math.min(chunks.length, Math.floor(cap)));
  const base = Math.min(maximum, Math.ceil(chunks.length * Math.max(0, Math.min(1, sampleRate))));
  const uncertain = priorities.filter(score => Number.isFinite(score) && score > 0).length;
  const count = Math.min(maximum, base + Math.ceil(uncertain * (1 - Math.max(0, Math.min(1, sampleRate)))));
  if (!uncertain) return selectGraphExtractionChunks(chunks, count);
  const selected = new Set(selectGraphExtractionChunks(chunks, Math.ceil(count / 2)).map(row => row.idx));
  const ranked = chunks.map((_, idx) => ({ idx, score: Math.max(0, priorities[idx] || 0) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.idx - b.idx);
  for (const row of ranked) { if (selected.size >= count) break; selected.add(row.idx); }
  for (const row of selectGraphExtractionChunks(chunks, count)) { if (selected.size >= count) break; selected.add(row.idx); }
  return [...selected].sort((a, b) => a - b).map(idx => ({ chunk: chunks[idx], idx }));
}

/** Successful graph misses influence only future extraction, never answer facts. */
export class GraphMissFeedback {
  private readonly scopes = new Map<string, { expiresAt: number; terms: Map<string, number> }>();
  record(kbIds: string[], terms: string[], now = Date.now()): void {
    for (const kbId of kbIds) {
      const previous = this.scopes.get(kbId);
      const scope = previous && previous.expiresAt > now ? previous : { expiresAt: now + 86400000, terms: new Map<string, number>() };
      for (const term of terms.slice(0, 16)) {
        const key = term.trim().toLowerCase().slice(0, 100);
        if (key.length >= 2) scope.terms.set(key, Math.min(10, (scope.terms.get(key) || 0) + 1));
      }
      scope.terms = new Map([...scope.terms].sort((a, b) => b[1] - a[1]).slice(0, 100));
      this.scopes.delete(kbId); this.scopes.set(kbId, scope);
    }
    while (this.scopes.size > 128) this.scopes.delete(this.scopes.keys().next().value!);
  }
  score(kbId: string | undefined, content: string, now = Date.now()): number {
    const scope = kbId ? this.scopes.get(kbId) : undefined;
    if (!scope || scope.expiresAt <= now) return 0;
    const text = content.toLowerCase();
    return [...scope.terms].reduce((sum, [term, count]) => sum + (text.includes(term) ? count : 0), 0);
  }
  identity(kbId: string, now = Date.now()): Array<[string, number]> {
    const scope = this.scopes.get(kbId);
    return scope && scope.expiresAt > now ? [...scope.terms].sort(([a], [b]) => a.localeCompare(b)) : [];
  }
}
