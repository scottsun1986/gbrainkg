import { formatVectorValues, TenantContextService, withServiceContext, withPermissionRead, withAdminInventory, withSystemWrite } from './tenant-context.service';

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

describe('TenantContextService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(mockTx));
  });

  it('runs the callback inside a plain transaction and propagates the result', async () => {
    const svc = new TenantContextService();
    const result = await svc.forService(async (tx) => {
      expect(tx).toBe(mockTx);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
  });

  it('propagates callback errors', async () => {
    const svc = new TenantContextService();
    await expect(svc.forUser('user-1', async () => 42)).resolves.toBe(42);
    await expect(
      svc.forService(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('transaction context helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(mockTx));
  });

  it('scopes work with a transaction when the client supports it', async () => {
    const seen: string[] = [];
    await withServiceContext(mockPrisma, async (tx) => {
      seen.push('fn');
      expect(tx).toBe(mockTx);
      return 1;
    });
    expect(seen).toEqual(['fn']);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
  });

  it('falls back to a direct call for unit-test doubles without $transaction', async () => {
    const bare = { $queryRaw: jest.fn() };
    await withServiceContext(bare as any, async (tx) => {
      expect(tx).toBe(bare);
      return 1;
    });
  });

  it.each([withPermissionRead, withAdminInventory])('wraps reads in a transaction', async (read) => {
    await read(mockPrisma, async (tx) => {
      expect(tx).toBe(mockTx);
      return 'scope-result';
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('wraps explicit system writes in a transaction', async () => {
    await expect(withSystemWrite(mockPrisma, async (tx) => {
      expect(tx).toBe(mockTx);
      return 'written';
    })).resolves.toBe('written');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
