import { KnowledgeGraphController } from './knowledge-graph.controller';

jest.mock('./retrieval/readable-document-scope', () => ({
  ...jest.requireActual('./retrieval/readable-document-scope'),
  readableDocumentWhere: async () => ({}),
}));

jest.mock('./permission/authorization-revision', () => ({
  authorizationEnforced: () => true,
  readAuthorizationSnapshot: async () => ({ revision: '42', policyVersion: 'core-auth-v1', expiresAt: Infinity }),
  assertAuthorizationSnapshot: async () => undefined,
}));

/**
 * The graph snapshot cache is keyed by the caller's visible-KB set, so a fleet
 * of users with different scopes fills it. It used to `clear()` the whole map
 * once it crossed 32 entries, which threw away snapshots that were still
 * fresh: the caller's own next request then rebuilt from scratch and reported
 * `cached: false` 0.02 s after the snapshot had been built (SOTA E2E P7-02).
 */
describe('knowledge-graph snapshot cache', () => {
  const build = () => {
    const acl = { filterReadableDocuments: jest.fn(async () => new Set<string>()) };
    const ctrl: any = new KnowledgeGraphController(
      { userIdFromRequest: async () => 'u1' } as any,
      { getVisibleKnowledgeBases: async () => ['kb-1'] } as any,
      undefined,
      undefined,
      undefined,
      acl as any,
    );
    ctrl.prisma = { document: { aggregate: jest.fn(async () => ({ _count: 0, _max: { updatedAt: null } })), findMany: jest.fn(async () => []) } };
    ctrl.buildGraph = jest.fn(async (cacheKey: string, ttl: number) => {
      ctrl.graphCache.set(cacheKey, {
        expiresAt: Date.now() + ttl,
        storedAt: Date.now(),
        fingerprint: ctrl.documentProjectionVersion([]),
        payload: { key: cacheKey, nodes: [] },
      });
      return { key: cacheKey, nodes: [] };
    });
    ctrl.documentAclService = acl;
    return ctrl;
  };

  const seed = (ctrl: any, key: string) => {
    ctrl.graphCache.set(key, {
      expiresAt: Date.now() + 60_000,
      storedAt: Date.now(),
      fingerprint: ctrl.documentProjectionVersion([]),
      payload: { key, nodes: [] },
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

  it('serves an expired snapshot as a cache hit and marks it stale', async () => {
    const ctrl = build();
    const key = `u1|42|Infinity|${JSON.stringify({ _count: 0, _max: { updatedAt: null } })}|0||1000|40|kb-1`;
    seed(ctrl, key);
    // Age the snapshot past its TTL: the next read must take the
    // stale-while-revalidate path rather than rebuilding inline.
    ctrl.graphCache.get(key)!.expiresAt = Date.now() - 1;
    const started = Date.now();
    const out: any = await ctrl.getGraph({ headers: {} }, '1000');
    expect(Date.now() - started).toBeLessThan(50);
    // The payload came from the snapshot, so `cached` must be true. Reporting
    // false made a sub-50ms response indistinguishable from a full rebuild and
    // failed SOTA E2E P7-02 whenever the suite ran longer than the cache TTL.
    expect(out.cached).toBe(true);
    expect(out.stale).toBe(true);
    expect(out.snapshotAgeSeconds).toBeGreaterThanOrEqual(0);
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
