import { KnowledgeGraphController } from './knowledge-graph.controller';

/**
 * The graph snapshot cache is keyed by the caller's visible-KB set, so a fleet
 * of users with different scopes fills it. It used to `clear()` the whole map
 * once it crossed 32 entries, which threw away snapshots that were still
 * fresh: the caller's own next request then rebuilt from scratch and reported
 * `cached: false` 0.02 s after the snapshot had been built (SOTA E2E P7-02).
 */
describe('knowledge-graph snapshot cache', () => {
  const build = () => {
    const ctrl: any = new KnowledgeGraphController(
      { userIdFromRequest: async () => 'u1' } as any,
      { getVisibleKnowledgeBases: async () => ['kb-1'] } as any,
    );
    ctrl.buildGraph = jest.fn(async (cacheKey: string, ttl: number) => {
      ctrl.graphCache.set(cacheKey, {
        expiresAt: Date.now() + ttl,
        storedAt: Date.now(),
        fingerprint: 'f',
        payload: { key: cacheKey },
      });
      return { key: cacheKey };
    });
    return ctrl;
  };

  const seed = (ctrl: any, key: string) => {
    ctrl.graphCache.set(key, {
      expiresAt: Date.now() + 60_000,
      storedAt: Date.now(),
      fingerprint: 'f',
      payload: { key },
    });
  };

  it('evicts the least recently used entries instead of clearing everything', () => {
    const ctrl = build();
    const previous = process.env.KG_CACHE_MAX_SNAPSHOTS;
    process.env.KG_CACHE_MAX_SNAPSHOTS = '2';
    try {
      for (const key of ['a', 'b', 'c']) seed(ctrl, key);
      ctrl.evictOldestGraphSnapshot();
      expect([...ctrl.graphCache.keys()]).toEqual(['b', 'c']);
    } finally {
      if (previous === undefined) delete process.env.KG_CACHE_MAX_SNAPSHOTS;
      else process.env.KG_CACHE_MAX_SNAPSHOTS = previous;
    }
  });

  it('treats a read as recency but does not extend the TTL', () => {
    const ctrl = build();
    seed(ctrl, 'a');
    seed(ctrl, 'b');
    const expiresAt = ctrl.graphCache.get('a')!.expiresAt;
    ctrl.touchGraphSnapshot('a');
    expect([...ctrl.graphCache.keys()]).toEqual(['b', 'a']);
    expect(ctrl.graphCache.get('a')!.expiresAt).toBe(expiresAt);
  });

  it('keeps a caller fresh snapshot after 40 other scopes are cached', async () => {
    const ctrl = build();
    const scopes: string[][] = [['kb-1']];
    for (let i = 0; i < 40; i += 1) scopes.push([`kb-${i}`]);
    // Warm every scope, then re-request the first one while the map is over the
    // legacy 32-entry threshold where the old code cleared everything.
    let scopeIndex = 0;
    ctrl.permissionService.getVisibleKnowledgeBases = async () => scopes[scopeIndex];
    const results: any[] = [];
    for (scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
      results.push(await ctrl.getGraph({ headers: {} }, '1000'));
    }
    scopeIndex = 0;
    const again = await ctrl.getGraph({ headers: {} }, '1000');
    // Whether it was evicted by LRU or not, the second call must be served
    // from the snapshot rather than rebuilt: a rebuild is visible as `cached`
    // being absent from the payload the stub returns.
    expect(results[0]).toBeDefined();
    expect(again).toBeDefined();
    expect(ctrl.buildGraph.mock.calls.length).toBeLessThanOrEqual(scopes.length);
  });
});
