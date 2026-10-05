import { semanticCacheScopeKey } from './chat.service';

describe('semanticCacheScopeKey', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });
  it('isolates answers produced before accuracy-first activation', () => {
    process.env.RETRIEVAL_QUALITY_PROFILE = 'balanced';
    const before = semanticCacheScopeKey(['source'], 1, 1, 'model', 'user');
    process.env.RETRIEVAL_QUALITY_PROFILE = 'quality-first';
    expect(semanticCacheScopeKey(['source'], 1, 1, 'model', 'user')).not.toBe(before);
  });
  const keys = ['kb-aaa-source', 'kb-bbb-source'];

  it('is deterministic and order-independent', () => {
    expect(semanticCacheScopeKey(keys, 1, 1)).toBe(semanticCacheScopeKey([...keys].reverse(), 1, 1));
  });

  it('changes when the selected source subset changes', () => {
    const full = semanticCacheScopeKey(keys, 1, 1);
    const subset = semanticCacheScopeKey(['kb-aaa-source'], 1, 1);
    expect(subset).not.toBe(full);
  });

  it('changes when the ACL epoch changes (permission revocation)', () => {
    expect(semanticCacheScopeKey(keys, 2, 1)).not.toBe(semanticCacheScopeKey(keys, 1, 1));
  });

  it('changes when the modelName changes', () => {
    expect(semanticCacheScopeKey(keys, 1, 1, 'model-a')).not.toBe(
      semanticCacheScopeKey(keys, 1, 1, 'model-b'),
    );
  });

  it('changes when the requesting user changes (same permission scope)', () => {
    // Two users can share one BrainScope (identical visible KB set), which is
    // exactly the case that used to let one user replay another user's answer.
    const userA = semanticCacheScopeKey(keys, 1, 1, 'model-a', 'user-a');
    const userB = semanticCacheScopeKey(keys, 1, 1, 'model-a', 'user-b');
    expect(userA).not.toBe(userB);
    // Same user + same scope stays stable so the cache still works per user.
    expect(semanticCacheScopeKey(keys, 1, 1, 'model-a', 'user-a')).toBe(userA);
  });

  it('changes when any retrieval-behaviour knob changes (P1-4 config fingerprint)', () => {
    // Flipping the soft-floor flag changes what evidence reaches the model, so
    // answers cached under the old flag must never be replayed under the new
    // one — without an operator remembering to bump the version salt.
    delete process.env.RETRIEVAL_SOFT_FLOOR_ENABLED;
    const offKey = semanticCacheScopeKey(keys, 1, 1, 'model-a', 'user-a');
    process.env.RETRIEVAL_SOFT_FLOOR_ENABLED = 'true';
    const onKey = semanticCacheScopeKey(keys, 1, 1, 'model-a', 'user-a');
    expect(onKey).not.toBe(offKey);
    // Stable for unrelated env noise and across calls with identical config.
    process.env.UNRELATED_ENV_VAR = 'noise';
    expect(semanticCacheScopeKey(keys, 1, 1, 'model-a', 'user-a')).toBe(onKey);
  });

  it('changes when the rerank capacity changes (P1-4)', () => {
    delete process.env.RERANK_MAX_DOCS;
    const base = semanticCacheScopeKey(keys, 1, 1);
    process.env.RERANK_MAX_DOCS = '60';
    expect(semanticCacheScopeKey(keys, 1, 1)).not.toBe(base);
  });
});
