import { IngestionService } from './ingestion.service';

const mockPrisma = {
  document: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('ingestion version fencing', () => {
  const queue = { add: jest.fn() };
  const compiler = { onKnowledgePublished: jest.fn() };
  const models = { getOcrConfig: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

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
});
