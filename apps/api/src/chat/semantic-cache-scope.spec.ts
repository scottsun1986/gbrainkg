import { semanticCacheScopeKey } from './chat.service';

describe('semanticCacheScopeKey', () => {
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
});
