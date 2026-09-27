/**
 * Select search results from a scored passage pool. A document's strongest
 * passage represents it in the first pass; other passages remain available to
 * fill unused slots. This avoids spending the whole top-k on one long document
 * without discarding evidence from that document when the corpus is small.
 *
 * Probe groups receive a small, score-gated opportunity to contribute a
 * different document. The gate and quota keep noisy sub-question probes from
 * displacing the main question's strongest matches.
 */
export function selectDiverseSearchCitations<T extends {
  docId?: string | null;
  documentId?: string | null;
  subQueryOrigin?: string | null;
  score?: number | null;
  chunkId?: string | null;
  id?: string | null;
  ord?: number | null;
  evidence?: string | null;
  snippet?: string | null;
}>(citations: T[], limit: number): T[] {
  if (limit <= 0 || citations.length === 0) return [];
  const ranked = citations
    .map((citation, index) => ({ citation, index }))
    .sort((a, b) => (Number(b.citation.score) || 0) - (Number(a.citation.score) || 0) || a.index - b.index);
  const selected = new Set<number>();
  const seenDocs = new Set<string>();
  const seenPassages = new Set<string>();
  const docKey = (citation: T, index: number): string => {
    const id = citation.docId || citation.documentId;
    // Sources without a document ID cannot safely be collapsed by title.
    return id ? `doc:${id}` : `unknown:${index}`;
  };
  const passageKey = (citation: T, index: number): string => {
    const doc = docKey(citation, index);
    const chunk = citation.chunkId || citation.id;
    if (chunk) return `${doc}:chunk:${chunk}`;
    if (citation.ord !== undefined && citation.ord !== null) return `${doc}:ord:${citation.ord}`;
    return `${doc}:text:${String(citation.evidence || citation.snippet || '').replace(/\s+/g, '').slice(0, 100)}`;
  };
  const add = (item: (typeof ranked)[number]): boolean => {
    if (selected.size >= limit || selected.has(item.index)) return false;
    const key = passageKey(item.citation, item.index);
    if (seenPassages.has(key)) return false;
    selected.add(item.index);
    seenDocs.add(docKey(item.citation, item.index));
    seenPassages.add(key);
    return true;
  };

  // Protect the best two distinct documents and their ordering at the head.
  const headSlots = Math.min(2, limit);
  for (const item of ranked) {
    if (selected.size >= headSlots) break;
    if (!seenDocs.has(docKey(item.citation, item.index))) add(item);
  }

  // Each independently reranked hop can surface a bridge document. Admit only
  // competitive group heads, with at most a quarter of the requested results.
  const probeQuota = Math.min(3, Math.floor(limit / 4));
  if (probeQuota > 0 && selected.size < limit) {
    const bestScore = Number(ranked[0]?.citation.score) || 0;
    const minProbeScore = Math.max(0.4, bestScore * 0.65);
    const usedGroups = new Set<string>();
    let admitted = 0;
    for (const item of ranked) {
      if (admitted >= probeQuota) break;
      const group = String(item.citation.subQueryOrigin || '').trim();
      if (!group || usedGroups.has(group)) continue;
      if ((Number(item.citation.score) || 0) < minProbeScore) continue;
      if (seenDocs.has(docKey(item.citation, item.index))) continue;
      if (add(item)) {
        usedGroups.add(group);
        admitted += 1;
      }
    }
  }

  // Fill with the best unseen document before admitting additional passages.
  for (const item of ranked) {
    if (selected.size >= limit) break;
    if (!seenDocs.has(docKey(item.citation, item.index))) add(item);
  }
  for (const item of ranked) {
    if (selected.size >= limit) break;
    add(item);
  }
  return ranked.filter((item) => selected.has(item.index)).map((item) => item.citation);
}
