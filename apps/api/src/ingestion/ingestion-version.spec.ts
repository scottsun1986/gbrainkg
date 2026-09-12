import { IngestionService } from './ingestion.service';

const mockPrisma = {
  document: { findUnique: jest.fn(), update: jest.fn() },
  chunk: { deleteMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(),
};
// Separate mock for the interactive-transaction client so specs can make the
// in-transaction version re-read diverge from the queue-time read.
const tx = {
  document: { findUnique: jest.fn(), update: jest.fn() },
  chunk: { deleteMany: jest.fn(), createMany: jest.fn() },
};
const mockReadFile = jest.fn();
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));
jest.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: jest.fn(),
}));
jest.mock('@firecrawl/anydoc', () => ({ toMarkdown: jest.fn() }));

describe('ingestion version fencing', () => {
  const queue = { add: jest.fn() };
  const enrichQueue = { add: jest.fn() };
  const compiler = { onKnowledgePublished: jest.fn().mockResolvedValue(1) };
  const models = { getOcrConfig: jest.fn(), getDefault: jest.fn().mockResolvedValue(null) };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AUTO_GRAPH_EXTRACT_ENABLED;
    mockPrisma.document.update.mockResolvedValue({});
    enrichQueue.add.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (client: typeof tx) => unknown)(tx);
      return Promise.all(arg as unknown[]);
    });
  });

  it('uses a stable document-version job identity', async () => {
    mockPrisma.document.findUnique.mockResolvedValue({ version: 3 });
    const service = new IngestionService(queue as any, compiler as any, models as any);
    await service.enqueue('0d802b54-a8e5-4df8-8bf7-baa7ae93f835');
    expect(queue.add).toHaveBeenCalledWith(
      'parse-document',
      expect.objectContaining({ expectedVersion: 3 }),
      expect.objectContaining({ jobId: 'ingest-0d802b54-a8e5-4df8-8bf7-baa7ae93f835-v3' }),
    );
  });

  it('does not let an obsolete queued version overwrite a newer document', async () => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: 'current.txt', rawFileOid: '/current',
      status: 'parsing', version: 4,
    });
    const service = new IngestionService(queue as any, compiler as any, models as any);
    await expect(service.processDocument('doc-1', 3)).resolves.toEqual(
      expect.objectContaining({ skipped: true, reason: 'superseded-version' }),
    );
    expect(mockPrisma.document.update).not.toHaveBeenCalled();
  });

  it('re-checks the version inside the save transaction and aborts on a mid-parse bump', async () => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: 'fixture.txt', rawFileOid: '/fixture',
      status: 'uploaded', version: 3,
    });
    tx.document.findUnique.mockResolvedValue({ version: 4 }); // re-uploaded while parsing
    mockReadFile.mockResolvedValue(Buffer.from('正常的合同条款内容'.repeat(20)));

    const service = new IngestionService(
      queue as any, compiler as any, models as any,
      undefined, undefined, undefined, enrichQueue as any,
    );
    const result = await service.processDocument('doc-1', 3);

    expect(result).toEqual(
      expect.objectContaining({ skipped: true, reason: 'superseded-version' }),
    );
    expect(tx.chunk.deleteMany).not.toHaveBeenCalled();
    expect(tx.chunk.createMany).not.toHaveBeenCalled();
    expect(compiler.onKnowledgePublished).not.toHaveBeenCalled();
    expect(enrichQueue.add).not.toHaveBeenCalled();
  });

  it('replaces chunks and carries the version into the enrichment job on the happy path', async () => {
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1', kbId: 'kb-1', title: 'fixture.txt', rawFileOid: '/fixture',
      status: 'uploaded', version: 3,
    });
    tx.document.findUnique.mockResolvedValue({ version: 3 });
    mockReadFile.mockResolvedValue(Buffer.from('正常的合同条款内容'.repeat(20)));

    const service = new IngestionService(
      queue as any, compiler as any, models as any,
      undefined, undefined, undefined, enrichQueue as any,
    );
    const result = await service.processDocument('doc-1', 3);

    expect(result.status).toBe('indexing');
    expect(tx.document.findUnique).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      select: { version: true },
    });
    expect(tx.chunk.deleteMany).toHaveBeenCalledWith({ where: { documentId: 'doc-1' } });
    expect(tx.chunk.createMany).toHaveBeenCalledTimes(1);
    expect(enrichQueue.add).toHaveBeenCalledWith(
      'enrich',
      expect.objectContaining({ documentId: 'doc-1', kbId: 'kb-1', expectedVersion: 3 }),
      expect.anything(),
    );
  });
});
