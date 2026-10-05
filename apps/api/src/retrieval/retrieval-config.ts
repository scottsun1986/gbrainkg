import { createHash } from 'node:crypto';

/**
 * Single source of truth for retrieval-behaviour environment knobs
 * (review 2026-10-05, §3.5).
 *
 * Code defaults and `.env.example` used to maintain two divergent copies, so
 * two instances of the same release could run different retrieval behaviour
 * (ratio 0.35 vs 0.22, timeout 15s vs 60s) with no way to tell from the trace.
 * This module is the canonical LIST of env keys that change retrieval
 * behaviour; the fingerprint below is embedded in the semantic-cache key
 * (so a config change invalidates cached answers automatically), and can be
 * logged at startup or attached to traces/eval reports to identify the exact
 * effective configuration.
 */
export const RETRIEVAL_ENV_KEYS = [
  // evidence selection
  'RETRIEVAL_RELEVANCE_FLOOR_RATIO',
  'RETRIEVAL_SOFT_FLOOR_ENABLED',
  'RETRIEVAL_MIN_FLOOR_GROUPS',
  'RETRIEVAL_MIN_VIABLE_RELEVANCE',
  'RETRIEVAL_SYNTHETIC_FILL_MAX',
  'RETRIEVAL_MAX_GROUPS',
  'RETRIEVAL_MAX_GROUPS_BREADTH',
  'RETRIEVAL_MAX_GROUPS_MULTIHOP',
  'RETRIEVAL_MMR_LAMBDA',
  'RETRIEVAL_CONTEXT_TOKEN_BUDGET',
  // rerank
  'RERANK_MAX_DOCS',
  'RERANK_TIMEOUT_MS',
  'RERANK_CASCADE_ENABLED',
  'RERANK_CASCADE_COARSE_K',
  'FORCE_PLATFORM_RERANK',
  // arms and profiles
  'RETRIEVAL_ARM_POLICY',
  'RETRIEVAL_QUALITY_PROFILE',
  'AGENTIC_RAG_ENABLED',
  'HYDE_ENABLED',
  'GRAPHRAG_DRIFT_ENABLED',
  'RAPTOR_ENABLED',
  'RETRIEVAL_PROBE_SCORE_SCALE',
] as const;

/** Stable short fingerprint of the currently effective retrieval config. */
export function retrievalConfigFingerprint(): string {
  const material = RETRIEVAL_ENV_KEYS.map((key) => `${key}=${process.env[key] ?? ''}`).join(';');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}
