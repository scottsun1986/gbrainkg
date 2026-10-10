import { DocumentVersionStore, versionTransactionBudget, artifactManifest } from './document-version-store';

jest.mock('../retrieval/lexical-index-store', () => ({
  unindexDocument: jest.fn().mockResolvedValue({ removed: 0, terms: 0 }),
  indexDocumentChunks: jest.fn().mockResolvedValue({ indexed: 1 }),
}));

/**
 * F09: version stage/publish are block-count-proportional transactions. The
 * 10k-block publish benchmark measured ~3.8s, so the default 5s Prisma
 * interactive budget is close to the failure boundary and a larger document
 * would be closed mid-build. These cases pin the explicit, bounded budget and
 * its env override; the transaction still rolls back entirely on timeout.
 */
const tx = {
  documentVersion: { findUnique: jest.fn(), update: jest.fn() },
  document: { findUnique: jest.fn(), update: jest.fn() },
  documentVersionLink: { findMany: jest.fn().mockResolvedValue([]) },
  blockArtifact: { findMany: jest.fn() },
  chunk: { deleteMany: jest.fn() },
  indexGeneration: { upsert: jest.fn() },
  brainChangeEvent: { create: jest.fn() },
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
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

  it('retires chain predecessors inside the publish transaction (B02)', async () => {
    const storedBlocks = [{ ord: 0, content: 'hello', rawContent: 'hello', charStart: 0, charEnd: 5, metadata: {}, rawHash: 'h', indexTextHash: 'ih' }];
    const version = {
      id: 'v1', state: 'indexing', documentId: 'd1', number: 2, manifestHash: artifactManifest(storedBlocks),
      publicationData: {}, mdPath: 'd1/content.md', title: 't', document: { id: 'd1', kbId: 'kb1' },
    };
    tx.documentVersion.findUnique.mockResolvedValue(version);
    tx.document.findUnique.mockResolvedValue({ id: 'd1', buildingVersionId: 'v1', ingestVersion: 2, version: 2, kb: { status: 'active' } });
    tx.blockArtifact.findMany.mockResolvedValue(storedBlocks);
    tx.indexGeneration.upsert.mockResolvedValue({ id: 'g1', manifestHash: version.manifestHash });
    tx.$queryRaw.mockResolvedValue([{ total: 1, missing: 0 }]);
    tx.documentVersionLink.findMany.mockResolvedValue([{ fromDocumentId: 'old' }]);

    const store = new DocumentVersionStore(mockPrisma);
    await expect(store.publish('v1', 'fp')).resolves.toBe(true);

    // The predecessor switch is part of the same publish transaction: the doc
    // flips to published and the chain retirement runs after it, before any
    // derived event is written.
    expect(tx.document.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'published' }),
    }));
    expect(tx.documentVersionLink.findMany).toHaveBeenCalledWith({
      where: { toDocumentId: 'd1', relation: { not: 'translation' } },
      select: { fromDocumentId: true },
    });
    const retireCall = tx.$executeRaw.mock.calls.map(call => call[0]).find((raw: any) => String((raw?.strings ?? raw ?? []).join('')).includes(`'superseded'`));
    expect(retireCall).toBeTruthy();
  });
});
