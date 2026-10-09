import { measuredScoreOf } from '../retrieval/score-contract';

/**
 * Keeps only the citations that can legitimately support an answer.
 *
 * Two rules, both grounded in the score contract rather than business terms:
 *   1. A citation the reranker never measured cannot justify an answer, so it
 *      is dropped instead of being rendered with an unsupported score.
 *   2. A measured citation far below the top measured score is noise: it may
 *      stay retrievable for recall, but it must not be cited as support.
 *
 * Absolute thresholds are avoided because providers use different score
 * scales; only the ratio to the best measured score matters here.
 */
export function selectSupportingCitations<T extends { docTitle?: string; documentId?: string }>(
  citations: T[],
  options: { minMeasuredRatio?: number; keepUnmeasuredHead?: number } = {},
): T[] {
  const minMeasuredRatio = options.minMeasuredRatio ?? 0.2;
  const entries = citations
    .map((citation) => ({ citation, score: measuredScoreOf(citation) }))
    // A citation the reranker never scored was displaced by pool size, not
    // judged irrelevant. It must not be presented as support for a claim.
    .filter((entry) => (entry.citation as any).rerankSkipped !== true);
  const scored = entries.filter((entry) => entry.score !== null);
  const best = scored.reduce((max, entry) => (entry.score as number) > max ? (entry.score as number) : max, 0);
  if (best <= 0) {
    // Nothing scored: citations such as freshly compiled cards never went
    // through retrieval, and must still be usable as evidence.
    const unscored = entries.map((entry) => entry.citation);
    return unscored.slice(0, options.keepUnmeasuredHead ?? unscored.length);
  }
  // Entries with a measured score far below the best one are long-tail noise.
  // Entries with no measurement are left alone: dropping them would discard
  // evidence that was produced by compilation rather than by retrieval.
  const supported = entries.filter((entry) => entry.score === null || entry.score >= best * minMeasuredRatio);
  return supported.length ? supported.map((entry) => entry.citation) : entries.slice(0, 1).map((entry) => entry.citation);
}