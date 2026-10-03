/**
 * Cross-edition evidence alignment.
 *
 * Version-conflict detection used to only LABEL a document family ("v1, v2
 * exist, compare them") without making sure both editions' matching sections
 * were in the context. Production: a "V1 vs V2" question cited V1's 能力/行为
 * sections, but V2's counterparts (ord 11, 12) never reached the model, and an
 * attendance question cited only one edition so the other edition's 09:00 rule
 * was missing entirely.
 *
 * For every cited chunk, find the best-matching chunk of each OTHER edition in
 * the same family and add it, bounded. Pure functions: the caller does the DB
 * reads and the permission recheck.
 */

/** Strip version / draft markers so editions of one regulation share a key. */
export function normalizeFamilyTitle(title: string): string {
  return String(title || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[\(_\-\s]*[vV]\d+(?:\.\d+)*[\)\]_\-\s]*/g, '')
    .replace(/第[一二三四五六七八九十0-9]+版/g, '')
    .replace(/（修订版）|\(修订版\)|修订版|最终版|最新版|征求意见稿|试行|初稿/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function bigrams(text: string): Set<string> {
  const s = String(text || '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Share of the question's bigrams that occur in the text. */
function questionCoverage(q: Set<string>, text: Set<string>): number {
  if (!q.size) return 0;
  let hit = 0;
  for (const x of q) if (text.has(x)) hit++;
  return hit / q.size;
}

export interface AlignChunk {
  id: string;
  documentId: string;
  ord: number;
  text: string;
}

export interface AlignAnchor {
  documentId: string;
  text: string;
}

export interface AlignOptions {
  question: string;
  /** Hard cap on added chunks across all families. */
  max: number;
  /** Minimum combined score for an aligned chunk. */
  minScore?: number;
}

/**
 * Pick sibling-edition chunks aligned to the cited anchors.
 *
 * `families` maps a family key to its member document ids. `chunksByDoc` holds
 * candidate chunks of member documents. Chunks already cited are excluded by
 * the caller through `citedChunkIds`. Returned in descending score order.
 */
export function alignSiblingEditionChunks(
  anchors: AlignAnchor[],
  families: Map<string, string[]>,
  chunksByDoc: Map<string, AlignChunk[]>,
  citedChunkIds: Set<string>,
  opts: AlignOptions,
): Array<AlignChunk & { score: number; alignedFrom: string }> {
  const minScore = opts.minScore ?? 0.18;
  const q = bigrams(opts.question);
  const familyOf = new Map<string, string>();
  for (const [key, ids] of families) for (const id of ids) familyOf.set(id, key);

  const best = new Map<string, AlignChunk & { score: number; alignedFrom: string }>();
  for (const anchor of anchors) {
    const family = familyOf.get(anchor.documentId);
    if (!family) continue;
    const a = bigrams(anchor.text);
    for (const sibling of families.get(family) || []) {
      if (sibling === anchor.documentId) continue;
      let top: (AlignChunk & { score: number; alignedFrom: string }) | null = null;
      for (const chunk of chunksByDoc.get(sibling) || []) {
        if (citedChunkIds.has(chunk.id)) continue;
        const c = bigrams(chunk.text);
        // Section alignment dominates; question coverage breaks ties toward
        // the part of the section that answers what was asked.
        const score = 0.75 * jaccard(a, c) + 0.25 * questionCoverage(q, c);
        if (score >= minScore && (!top || score > top.score)) {
          top = { ...chunk, score, alignedFrom: anchor.documentId };
        }
      }
      if (top && (!best.has(top.id) || best.get(top.id)!.score < top.score)) best.set(top.id, top);
    }
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, Math.max(0, opts.max));
}
