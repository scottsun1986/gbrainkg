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

  it('changes when the knowledge epoch changes (content revision)', () => {
    expect(semanticCacheScopeKey(keys, 1, 2)).not.toBe(semanticCacheScopeKey(keys, 1, 1));
  });
});
