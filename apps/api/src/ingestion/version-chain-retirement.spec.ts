import { retireSupersededPredecessors } from './version-chain-retirement';

/** B02: retirement runs inside the successor's publish transaction and must be
 * a no-op without links, translation-proof, transitive over failed
 * intermediates, and idempotent on already-retired predecessors. The plain
 * jest.fn() used as the $executeRaw template tag receives the raw
 * template-strings array, so SQL text assertions read that array directly. */
describe('retireSupersededPredecessors', () => {
  function txWith(linkMap: Record<string, any[]>) {
    const tx: any = {
      documentVersionLink: {
        findMany: jest.fn(async ({ where }: any) => linkMap[where.toDocumentId] ?? []),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    return tx;
  }
  const sqlText = (call: any) => String((call?.strings ?? call ?? []).join(''));

  it('does nothing when the document has no version-chain links', async () => {
    const tx = txWith({});
    expect(await retireSupersededPredecessors(tx, 'doc-1')).toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('retires current supersedes/revision predecessors with a future effectiveTo preserved', async () => {
    const tx = txWith({ 'doc-1': [{ fromDocumentId: 'old-a' }, { fromDocumentId: 'old-a' }, { fromDocumentId: 'old-b' }] });
    expect(await retireSupersededPredecessors(tx, 'doc-1')).toBe(1);
    expect(tx.documentVersionLink.findMany).toHaveBeenCalledWith({
      where: { toDocumentId: 'doc-1', relation: { not: 'translation' } },
      select: { fromDocumentId: true },
    });
    const raw = tx.$executeRaw.mock.calls[0][0];
    expect(sqlText(raw)).toContain(`'superseded'`);
    expect(sqlText(raw)).toContain(`COALESCE("effectiveTo", now())`);
    expect(sqlText(raw)).toContain(`"lifecycleStatus" = 'current'`);
    // The predecessor id list is the single interpolated argument.
    expect(tx.$executeRaw.mock.calls[0][1]).toEqual(['old-a', 'old-b']);
  });
  it('walks past a failed intermediate so the whole chain retires at the newest publish', async () => {
    const tx = txWith({
      'new': [{ fromDocumentId: 'failed-mid' }],
      'failed-mid': [{ fromDocumentId: 'original' }],
      'original': [],
    });
    expect(await retireSupersededPredecessors(tx, 'new')).toBe(1);
    expect(tx.$executeRaw.mock.calls[0][1]).toEqual(['failed-mid', 'original']);
  });
  it('queries with the translation-excluding predicate so translation-only chains never retire', async () => {
    const tx = txWith({ 'translation-doc': [{ fromDocumentId: 'original' }] });
    expect(await retireSupersededPredecessors(tx, 'translation-doc')).toBe(1);
    expect(tx.documentVersionLink.findMany).toHaveBeenCalledWith({
      where: { toDocumentId: 'translation-doc', relation: { not: 'translation' } },
      select: { fromDocumentId: true },
    });
  });
});
