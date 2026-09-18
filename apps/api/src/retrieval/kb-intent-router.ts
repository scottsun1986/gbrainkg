export interface KnowledgeBaseMetadata {
  id: string;
  name: string;
  description?: string | null;
  domainTerms?: string[] | unknown;
}

export interface RouteOptions {
  maxTargetKbs?: number;
  minScoreThreshold?: number;
}

/**
 * In-memory TTL cache for KB metadata to avoid repeated DB queries during intent routing.
 */
class KbMetaCache {
  private cache = new Map<string, { data: KnowledgeBaseMetadata; expiresAt: number }>();
  private readonly ttlMs = 60_000; // 60s cache

  get(id: string): KnowledgeBaseMetadata | null {
    const entry = this.cache.get(id);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.data;
    }
    return null;
  }

  set(id: string, data: KnowledgeBaseMetadata): void {
    this.cache.set(id, { data, expiresAt: Date.now() + this.ttlMs });
    if (this.cache.size > 500) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  delete(id: string): void {
    this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const kbMetaCache = new KbMetaCache();

/**
 * Extracts candidate tokens from a query for intent routing against KB metadata.
 */
export function extractRoutingTokens(query: string): string[] {
  if (!query || typeof query !== 'string') return [];
  const clean = query.replace(/[?？!！,，.。、:：;；"“”'‘’\(\)（）\[\]【】\s]+/g, ' ').trim();
  const tokens = new Set<string>();

  // 1. English words / identifiers
  const words = clean.match(/[A-Za-z0-9_\-]+/g) || [];
  for (const w of words) {
    if (w.length >= 2) tokens.add(w.toLowerCase());
  }

  // 2. Chinese segments (sliding window of 2 to 4 chars for unigrams/bigrams/trigrams)
  const cnMatches = clean.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const cn of cnMatches) {
    if (cn.length >= 2 && cn.length <= 12) {
      tokens.add(cn);
    }
    // Sub-grams of 2-3 characters
    for (let i = 0; i < cn.length - 1; i++) {
      tokens.add(cn.slice(i, i + 2));
      if (i + 3 <= cn.length) {
        tokens.add(cn.slice(i, i + 3));
      }
    }
  }

  return Array.from(tokens).slice(0, 50);
}

/**
 * Scores a Knowledge Base against query tokens.
 */
export function scoreKbRelevance(kb: KnowledgeBaseMetadata, queryTokens: string[]): number {
  if (!queryTokens.length) return 0;
  let score = 0;
  const nameLower = (kb.name || '').toLowerCase();
  const descLower = (kb.description || '').toLowerCase();

  let domainTermsList: string[] = [];
  if (Array.isArray(kb.domainTerms)) {
    domainTermsList = kb.domainTerms.map((t) => String(t).toLowerCase());
  } else if (typeof kb.domainTerms === 'object' && kb.domainTerms !== null) {
    domainTermsList = Object.values(kb.domainTerms).map((t) => String(t).toLowerCase());
  }

  for (const token of queryTokens) {
    const tLower = token.toLowerCase();
    // High weight for KB Name match
    if (nameLower.includes(tLower)) {
      score += token.length >= 3 ? 5 : 3;
    }
    // High weight for Domain Terms match
    if (domainTermsList.some((dt) => dt.includes(tLower) || tLower.includes(dt))) {
      score += 4;
    }
    // Moderate weight for Description match
    if (descLower.includes(tLower)) {
      score += 1.5;
    }
  }

  return score;
}

/**
 * Intelligent Knowledge Base Intent Router.
 * When the search scope includes many KBs (e.g. > 3), scores candidate KBs and routes
 * the query to the Top-K relevant knowledge bases, shrinking search space and query latency.
 * Falls back to the full scope if no specific KB exhibits strong intent affinity.
 */
export async function routeKnowledgeBasesByIntent(
  query: string,
  scope: string[],
  fetchMetadataFn: (kbIds: string[]) => Promise<KnowledgeBaseMetadata[]>,
  options: RouteOptions = {},
): Promise<{ targetedScope: string[]; routed: boolean; scores: Record<string, number> }> {
  const maxTargetKbs = Math.max(1, options.maxTargetKbs ?? 3);
  const minScoreThreshold = options.minScoreThreshold ?? 2.0;

  if (scope.length <= 2) {
    return { targetedScope: scope, routed: false, scores: {} };
  }

  // Check cache for metadata or fetch
  const missingIds: string[] = [];
  const kbList: KnowledgeBaseMetadata[] = [];
  for (const id of scope) {
    const cached = kbMetaCache.get(id);
    if (cached) {
      kbList.push(cached);
    } else {
      missingIds.push(id);
    }
  }

  if (missingIds.length > 0) {
    const fetched = await fetchMetadataFn(missingIds).catch(() => []);
    for (const kb of fetched) {
      kbMetaCache.set(kb.id, kb);
      kbList.push(kb);
    }
  }

  const queryTokens = extractRoutingTokens(query);
  if (!queryTokens.length) {
    return { targetedScope: scope, routed: false, scores: {} };
  }

  const scoredKbs = kbList.map((kb) => ({
    id: kb.id,
    score: scoreKbRelevance(kb, queryTokens),
  }));

  const scoresRecord: Record<string, number> = {};
  scoredKbs.forEach((k) => (scoresRecord[k.id] = k.score));

  scoredKbs.sort((a, b) => b.score - a.score);

  const topMatches = scoredKbs.filter((k) => k.score >= minScoreThreshold);

  // If we found strong matches among the candidates, narrow the scope to Top-K
  if (topMatches.length > 0) {
    const selectedIds = topMatches.slice(0, maxTargetKbs).map((k) => k.id);
    return {
      targetedScope: selectedIds,
      routed: true,
      scores: scoresRecord,
    };
  }

  // Safe fallback to full scope
  return { targetedScope: scope, routed: false, scores: scoresRecord };
}
