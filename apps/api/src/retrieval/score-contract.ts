import { getRequestContext } from '../observability/request-context';

/**
 * Unified candidate score contract (review 2026-10-05, §3.1 / P0-2).
 *
 * The retrieval chain produces several numerically similar but semantically
 * different scores: RRF ranks, min-max synthetic arm scores (0.05–0.99 with the
 * top hit always ~0.95), rescue placement constants, raw cross-encoder scores
 * and Platt-calibrated probabilities. Comparing them against each other — a
 * fabricated 0.95 next to a genuine 0.4 rerank score — is how rerank-cap
 * overflow candidates ended up owning guaranteed selection slots.
 *
 * Three rules govern every consumer (selectEvidence, decideEvidenceSufficiency,
 * assessWeakEvidence):
 *
 *  1. Ordering between pools looks at recall ordinal, not at the number.
 *  2. Thresholds (relevance floor, guaranteed-slot viability, refusal floors)
 *     act ONLY on measured scores.
 *  3. Synthetic scores may fill leftover context capacity, never compete with
 *     measured evidence for floor-protected slots.
 */

export type ScoreProvenance = 'rerank' | 'native' | 'synthetic' | 'summary';

export interface ScoredCandidate {
  /** Rank inside the arm that produced the candidate (0 = best of that arm). */
  ordinal: number;
  /**
   * A score an external scorer actually measured for this (query, passage)
   * pair: raw cross-encoder score, or the Platt-calibrated probability in
   * adaptive mode. Null when the number is arm-local (synthetic/min-max/
   * placement constant) or the candidate was never cross-encoded.
   */
  measured: number | null;
  provenance: ScoreProvenance;
}

/**
 * The measured score of a citation under the unified contract.
 *
 * Same scale rules as calibratedScoreOf, plus one guard that closes the P0-2
 * hole: candidates kept beyond the rerank capacity (`rerankSkipped`, set when
 * the pool exceeded RERANK_MAX_DOCS) were never scored by the cross-encoder,
 * so whatever score they still carry is their arm-local number and must not
 * act as a measurement anywhere.
 */
export function measuredScoreOf(citation: any): number | null {
  if (!citation) return null;
  if (citation.rerankSkipped === true) return null;
  if (String(citation.scoreSource || '') === 'synthetic') return null;
  if (getRequestContext()?.execution?.adaptive) {
    const probability = citation.calibratedProbability;
    return typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1
      ? probability
      : null;
  }
  const value = Number(citation.relevanceScore ?? citation.rerankScore ?? citation.score);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function provenanceOf(citation: any): ScoreProvenance {
  const source = String(citation?.scoreSource || '');
  if (source === 'rerank') return 'rerank';
  if (source === 'native') return 'native';
  if (citation?.raptor === true || citation?.isSummary === true) return 'summary';
  return 'synthetic';
}

export function scoreCandidate(citation: any, ordinal: number): ScoredCandidate {
  return {
    ordinal,
    measured: measuredScoreOf(citation),
    provenance: provenanceOf(citation),
  };
}
