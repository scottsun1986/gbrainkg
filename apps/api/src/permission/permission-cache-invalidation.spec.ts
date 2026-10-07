jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({})),
}));

import { PermissionService } from './permission.service';

function fakeRedis(instanceId: string) {
  return {
    publish: jest.fn().mockResolvedValue(true),
    subscribe: jest.fn().mockResolvedValue(undefined),
    getInstanceId: jest.fn().mockReturnValue(instanceId),
  } as any;
}

describe('PermissionService cross-replica cache invalidation', () => {
  it('publishes an invalidation carrying this instance id and the affected user', () => {
    const redis = fakeRedis('inst-a');
    const service = new PermissionService(redis);
    (service as any).visibleKbsCache.set('u1', { expiresAt: Date.now() + 1000, value: ['kb'] });

    service.invalidatePermissionCaches('u1');

    expect((service as any).visibleKbsCache.has('u1')).toBe(false);
    expect(redis.publish).toHaveBeenCalledWith('permission-cache-invalidation', {
      instanceId: 'inst-a',
      userId: 'u1',
    });
  });

  it('applies a peer broadcast but ignores its own echo', () => {
    const service = new PermissionService(fakeRedis('inst-a'));
    const cache = (service as any).visibleKbsCache;

    cache.set('u2', { expiresAt: Date.now() + 1000, value: ['kb'] });
    (service as any).handleInvalidationMessage(
      JSON.stringify({ instanceId: 'inst-b', userId: 'u2' }),
    );
    expect(cache.has('u2')).toBe(false);

    cache.set('u3', { expiresAt: Date.now() + 1000, value: ['kb'] });
    (service as any).handleInvalidationMessage(
      JSON.stringify({ instanceId: 'inst-a', userId: 'u3' }),
    );
    expect(cache.has('u3')).toBe(true);
  });

  it('clears every cache on a global (no-user) invalidation', () => {
    const service = new PermissionService(fakeRedis('inst-a'));
    (service as any).visibleKbsCache.set('u1', { expiresAt: Date.now() + 1000, value: [] });
    (service as any).systemAdminCache.set('u1', { expiresAt: Date.now() + 1000, value: true });

    (service as any).handleInvalidationMessage(
      JSON.stringify({ instanceId: 'inst-b', userId: null }),
    );

    expect((service as any).visibleKbsCache.size).toBe(0);
    expect((service as any).systemAdminCache.size).toBe(0);
  });

  it('ignores malformed messages', () => {
    const service = new PermissionService(fakeRedis('inst-a'));
    expect(() => (service as any).handleInvalidationMessage('not-json')).not.toThrow();
  });

  it('still invalidates locally when Redis is not configured', () => {
    const service = new PermissionService();
    (service as any).visibleKbsCache.set('u1', { expiresAt: Date.now() + 1000, value: [] });
    expect(() => service.invalidatePermissionCaches('u1')).not.toThrow();
    expect((service as any).visibleKbsCache.has('u1')).toBe(false);
  });
});
