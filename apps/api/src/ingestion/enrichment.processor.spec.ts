import { EnrichmentProcessor } from './enrichment.processor';

const mockPrisma = {
  document: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('EnrichmentProcessor readiness gating', () => {
  const chunkEmbedding = {
    isEnabled: jest.fn(),
    embedDocumentChunks: jest.fn(),
    documentCoverage: jest.fn(),
  };
  const raptor = { isEnabled: jest.fn().mockReturnValue(false), indexDocument: jest.fn() };
  const graphRag = {};
  const models = { getDefault: jest.fn() };
  let processor: EnrichmentProcessor;

  const job = (data: Record<string, unknown>) =>
    ({ data, attemptsMade: 0 } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AUTO_GRAPH_EXTRACT_ENABLED;
    raptor.isEnabled.mockReturnValue(false);
    processor = new EnrichmentProcessor(
      chunkEmbedding as any,
      raptor as any,
      graphRag as any,
      models as any,
    );
  });

  it('marks the document degraded and rethrows when chunks are missing embeddings', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(true);
    chunkEmbedding.embedDocumentChunks.mockResolvedValue({ requested: 10, embedded: 7, failed: 3, missing: 3 });
    chunkEmbedding.documentCoverage.mockResolvedValue({ total: 10, missing: 3 });

    await expect(
      processor.process(job({ documentId: 'doc-1', kbId: 'kb-1' })),
    ).rejects.toThrow(/3\/10 chunks missing vectors/);

    const readinessWrites = mockPrisma.document.update.mock.calls.map(
      (call) => call[0].data.indexReadiness,
    );
    expect(readinessWrites).toEqual(['enriching', 'degraded']);
    expect(raptor.indexDocument).not.toHaveBeenCalled();
  });

  it('marks the document ready only when embedding coverage is complete', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(true);
    chunkEmbedding.embedDocumentChunks.mockResolvedValue({ requested: 10, embedded: 10, failed: 0, missing: 0 });
    chunkEmbedding.documentCoverage.mockResolvedValue({ total: 10, missing: 0 });

    await expect(
      processor.process(job({ documentId: 'doc-1', kbId: 'kb-1' })),
    ).resolves.toEqual({ readiness: 'ready' });

    const readinessWrites = mockPrisma.document.update.mock.calls.map(
      (call) => call[0].data.indexReadiness,
    );
    expect(readinessWrites).toEqual(['enriching', 'ready']);
  });

  it('keeps the legacy flow when the embedding service is disabled', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(false);

    await expect(
      processor.process(job({ documentId: 'doc-1', kbId: 'kb-1' })),
    ).resolves.toEqual({ readiness: 'ready' });

    expect(chunkEmbedding.embedDocumentChunks).not.toHaveBeenCalled();
    expect(chunkEmbedding.documentCoverage).not.toHaveBeenCalled();
    expect(mockPrisma.document.update).toHaveBeenCalledTimes(2); // enriching + ready
  });

  it('skips a superseded version without touching readiness state', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(true);
    mockPrisma.document.findUnique.mockResolvedValue({ version: 5 });

    await expect(
      processor.process(job({ documentId: 'doc-1', kbId: 'kb-1', expectedVersion: 4 })),
    ).resolves.toEqual({ readiness: 'superseded' });

    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(chunkEmbedding.embedDocumentChunks).not.toHaveBeenCalled();
  });

  it('proceeds when the job version still matches the document', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(true);
    chunkEmbedding.embedDocumentChunks.mockResolvedValue({ requested: 1, embedded: 1, failed: 0, missing: 0 });
    chunkEmbedding.documentCoverage.mockResolvedValue({ total: 1, missing: 0 });
    mockPrisma.document.findUnique.mockResolvedValue({ version: 4 });

    await expect(
      processor.process(job({ documentId: 'doc-1', kbId: 'kb-1', expectedVersion: 4 })),
    ).resolves.toEqual({ readiness: 'ready' });
  });
});
