/**
 * Local BM25 (Okapi, k1/b standard) over the lexical candidate pool.
 *
 * Replaces the previous "3 points if a 4-char keyword matched" heuristics:
 * within the candidate pool pulled by the contains queries, terms are weighted
 * by their actual pool-wide scarcity (local IDF) and in-document frequency,
 * with length normalisation. Pool-level IDF is an approximation of corpus IDF
 * but is monotone in term rarity and removes the fixed-score bias towards
 * boilerplate.
 */

export interface Bm25Doc {
  id: string;
  len: number;
  /** term -> raw frequency within this document */
  tf: Map<string, number>;
}

export interface Bm25Pool {
  N: number;
  avgLen: number;
  docs: Bm25Doc[];
  /** keyword -> number of pool documents containing it */
  df: Map<string, number>;
}

export function buildBm25Pool(
  entries: Array<{ id: string; text: string }>,
  keywords: string[],
): Bm25Pool {
  const kwList = keywords
    .map((k) => k.toLowerCase())
    .filter((k) => k.length >= 2);
  const docs: Bm25Doc[] = entries.map(({ id, text }) => {
    const tf = new Map<string, number>();
    const lower = String(text || '').toLowerCase();
    let len = lower.length;
    for (const kw of kwList) {
      if (!lower.includes(kw)) continue;
      const parts = lower.split(kw);
      tf.set(kw, parts.length - 1);
      len += kw.length * (parts.length - 1);
    }
    return { id, len, tf };
  });
  const df = new Map<string, number>();
  for (const kw of kwList) {
    let n = 0;
    for (const d of docs) if (d.tf.has(kw)) n++;
    df.set(kw, n);
  }
  const avgLen = docs.length ? docs.reduce((s, d) => s + d.len, 0) / docs.length : 1;
  return { N: docs.length, avgLen: avgLen || 1, docs, df };
}

/** Returns docId -> BM25 score (only docs with at least one matching term). */
export function bm25Scores(pool: Bm25Pool, k1 = 1.2, b = 0.75): Map<string, number> {
  const out = new Map<string, number>();
  if (!pool.N) return out;
  for (const doc of pool.docs) {
    if (!doc.tf.size) continue;
    let score = 0;
    for (const [kw, tf] of doc.tf) {
      const df = pool.df.get(kw) || 0;
      const idf = Math.log(1 + (pool.N - df + 0.5) / (df + 0.5));
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + (b * doc.len) / pool.avgLen));
      score += idf * norm;
    }
    if (score > 0) out.set(doc.id, score);
  }
  return out;
}
