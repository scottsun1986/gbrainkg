import { formatVectorValues, TenantContextService, withServiceContext } from './tenant-context.service';

const mockTx = {
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn().mockResolvedValue([]),
};
const mockPrisma = {
  $transaction: jest.fn(async (callback: any) => callback(mockTx)),
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn().mockResolvedValue([]),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  Prisma: { TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' } },
}));
jest.mock('../prisma', () => ({
  getPrismaClient: () => mockPrisma,
}));

describe('formatVectorValues', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('accepts uuid + numeric vector literals and emits typed VALUES tuples', () => {
    const out = formatVectorValues([{ id: uuid, vec: '[0.1, -2.5, 3e-2]' }]);
    expect(out).toBe(`('${uuid}'::uuid, '[0.1,-2.5,3e-2]'::vector)`);
  });

  it('rejects invalid uuids', () => {
    expect(() => formatVectorValues([{ id: 'chunk-1', vec: '[0.1]' }])).toThrow(/invalid uuid/);
    expect(() => formatVectorValues([{ id: "1' OR 1=1--", vec: '[0.1]' }])).toThrow(/invalid uuid/);
    expect(() => formatVectorValues([{ id: '', vec: '[0.1]' }])).toThrow(/invalid uuid/);
  });

  it('rejects non-numeric or non-vector payloads (blocks SQL injection via vec)', () => {
    expect(() => formatVectorValues([{ id: uuid, vec: "0.1'); DROP TABLE \"Chunk\";--" }])).toThrow(
      /invalid vector payload/,
    );
    expect(() => formatVectorValues([{ id: uuid, vec: '[0.1, now()]' }])).toThrow(/invalid vector payload/);
    expect(() => formatVectorValues([{ id: uuid, vec: '0.1,0.2' }])).toThrow(/invalid vector payload/);
    expect(() => formatVectorValues([{ id: uuid, vec: '[0.1]; DELETE FROM "Chunk"' }])).toThrow(
      /invalid vector payload/,
    );
  });

  it('joins multiple validated tuples with commas', () => {
    const id2 = '22222222-2222-4222-8222-222222222222';
    const out = formatVectorValues([
      { id: uuid, vec: '[1,2]' },
      { id: id2, vec: '[3,4]' },
    ]);
    expect(out).toBe(
      `('${uuid}'::uuid, '[1,2]'::vector),('${id2}'::uuid, '[3,4]'::vector)`,
    );
  });
});

describe('TenantContextService.forService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTx.$executeRaw.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(mockTx));
  });

  it('sets app.service=on (and clears app.user_id) before running the callback', async () => {
    const svc = new TenantContextService();
    const result = await svc.forService(async (tx) => {
      expect(tx).toBe(mockTx);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(2);

    const first = mockTx.$executeRaw.mock.calls[0];
    const second = mockTx.$executeRaw.mock.calls[1];
    expect(String(first[0])).toContain("set_config('app.user_id'");
    expect(first[1]).toBe('');
    expect(String(second[0])).toContain("set_config('app.service'");
    expect(second[1]).toBe('on');
  });

  it('propagates the callback result and errors', async () => {
    const svc = new TenantContextService();
    await expect(svc.forService(async () => 42)).resolves.toBe(42);
    await expect(
      svc.forService(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('withServiceContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTx.$executeRaw.mockResolvedValue(1);
  });

  it('scopes background work with app.service=on when the client supports transactions', async () => {
    const seen: string[] = [];
    await withServiceContext(mockPrisma, async (tx) => {
      seen.push('fn');
      expect(tx).toBe(mockTx);
      return 1;
    });
    expect(seen).toEqual(['fn']);
    const configs = mockTx.$executeRaw.mock.calls.map((c) => String(c[0]));
    expect(configs.some((s) => s.includes("set_config('app.service'"))).toBe(true);
    expect(configs.some((s) => s.includes("'on'"))).toBe(true);
  });

  it('keeps the request user context instead of downgrading to service scope', async () => {
    // Request-path arms (BGE-M3 sparse recall, semantic cache lookups) call
    // this helper from inside an HTTP request. Forcing app.service=on there
    // silently bypassed row-level security for those queries; the request
    // user's visibility must be preserved.
    const { runWithRequestContext } = require('../observability/request-context');
    await runWithRequestContext(
      { requestId: 'req-1', userId: 'user-9' },
      async () => {
        await withServiceContext(mockPrisma, async () => 'ok');
      },
    );
    const configs = mockTx.$executeRaw.mock.calls.map((c) => String(c[0]));
    expect(configs.some((s) => s.includes("set_config('app.user_id'"))).toBe(true);
    expect(mockTx.$executeRaw.mock.calls[0][1]).toBe('user-9');
    expect(configs.some((s) => s.includes("'off'"))).toBe(true);
    expect(configs.some((s) => s.includes("'on'"))).toBe(false);
  });

  it('falls back to a direct call for unit-test doubles without $transaction', async () => {
    const bare = { $queryRaw: jest.fn() };
    await withServiceContext(bare as any, async (tx) => {
      expect(tx).toBe(bare);
      return 1;
    });
  });
});
