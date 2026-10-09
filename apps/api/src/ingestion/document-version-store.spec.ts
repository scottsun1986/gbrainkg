import { DocumentVersionStore, versionTransactionBudget } from './document-version-store';

/**
 * F09: version stage/publish are block-count-proportional transactions. The
 * 10k-block publish benchmark measured ~3.8s, so the default 5s Prisma
 * interactive budget is close to the failure boundary and a larger document
 * would be closed mid-build. These cases pin the explicit, bounded budget and
 * its env override; the transaction still rolls back entirely on timeout.
 */
const tx = {
  documentVersion: { findUnique: jest.fn() },
  document: { findUnique: jest.fn(), update: jest.fn() },
  blockArtifact: { findMany: jest.fn() },
};
const mockPrisma: any = {
  $transaction: jest.fn(async (fn: any, options: any) => fn(tx, options)),
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('DocumentVersionStore transaction budget (F09)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes an explicit bounded budget to the publish transaction', async () => {
    tx.documentVersion.findUnique.mockResolvedValue({ id: 'v1', state: 'published', documentId: 'd1' });
    const store = new DocumentVersionStore(mockPrisma);
    await store.publish('v1', 'fp');
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'ReadCommitted', timeout: expect.any(Number), maxWait: expect.any(Number) }),
    );
    const options = mockPrisma.$transaction.mock.calls[0][1];
    expect(options.timeout).toBeGreaterThanOrEqual(5_000);
    expect(options.maxWait).toBeGreaterThanOrEqual(2_000);
  });

  it('keeps the budget env-configurable', () => {
    const previous = process.env.CORE_VERSION_TX_TIMEOUT_MS;
    process.env.CORE_VERSION_TX_TIMEOUT_MS = '250000';
    const budget = versionTransactionBudget();
    if (previous === undefined) delete process.env.CORE_VERSION_TX_TIMEOUT_MS;
    else process.env.CORE_VERSION_TX_TIMEOUT_MS = previous;
    expect(budget.timeoutMs).toBe(250_000);
    expect(budget.maxWaitMs).toBeGreaterThanOrEqual(2_000);
  });
});
