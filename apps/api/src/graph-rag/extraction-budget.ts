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
