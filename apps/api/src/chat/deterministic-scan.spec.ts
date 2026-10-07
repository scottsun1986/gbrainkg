import { scanDeterministicChunks } from './deterministic-scan';

describe('complete deterministic snapshot scan', () => {
  it('reads beyond 20000 with bounded keyset pages and ties on id', async () => {
    const rows = Array.from({ length: 21001 }, (_, index) => ({ id: String(index).padStart(6, '0'), documentId: 'doc', kbId: 'kb', ord: Math.floor(index / 2), content: 'text', metadata: {} }));
    const chunk = { count: jest.fn().mockResolvedValue(rows.length), findMany: jest.fn(async (args) => {
      expect(args.skip).toBeUndefined();
      expect(args.orderBy[2]).toEqual({ id: 'asc' });
      const lastId = args.where.AND?.[1].OR[2].id.gt;
      const index = lastId === undefined ? 0 : Number(lastId) + 1;
      return rows.slice(index, index + args.take);
    }) };
    const db = { $transaction: jest.fn(async (fn, _options?: any) => fn({ chunk })) };
    const where = { kbId: { in: ['kb'] }, document: { status: 'published' } };
    expect(await scanDeterministicChunks(db, where, 25000, 2000)).toEqual(rows);
    expect(db.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead', timeout: 120000 });
    expect(chunk.findMany.mock.calls[1][0].where.AND[0]).toBe(where);
  });
  it('rejects over-budget sources and broken snapshot scans', async () => {
    const chunk = { count: jest.fn().mockResolvedValue(3), findMany: jest.fn().mockResolvedValue([]) };
    const db = { $transaction: jest.fn(async (fn, _options?: any) => fn({ chunk })) };
    expect(await scanDeterministicChunks(db, { kbId: 'kb' }, 2)).toEqual([]);
    expect(chunk.findMany).not.toHaveBeenCalled();
    expect(await scanDeterministicChunks(db, { kbId: 'kb' }, 3)).toEqual([]);
    await expect(scanDeterministicChunks(db, {}, 0)).rejects.toThrow('budget');
  });
});
