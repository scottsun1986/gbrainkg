import { EnrichmentProcessor } from './enrichment.processor';

const mockPrisma: any = {
  document: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  enrichmentStage: { findMany: jest.fn(), upsert: jest.fn() },
  brainChangeEvent: { update: jest.fn(), upsert: jest.fn() },

  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

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
    mockPrisma.document.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.enrichmentStage.findMany.mockResolvedValue([]);
    mockPrisma.enrichmentStage.upsert.mockResolvedValue({});
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
      (call: any[]) => call[0].data.indexReadiness,
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
      (call: any[]) => call[0].data.indexReadiness,
    );
    expect(readinessWrites).toEqual(['enriching', 'ready']);
  });

  it('keeps a document degraded when a configured hybrid index is incomplete', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(true);
    chunkEmbedding.embedDocumentChunks.mockResolvedValue({ requested: 10, embedded: 10, failed: 0, missing: 0, hybridMissing: 2 });
    chunkEmbedding.documentCoverage.mockResolvedValue({ total: 10, missing: 0 });
    await expect(processor.process(job({ documentId: 'doc-1', kbId: 'kb-1' })))
      .rejects.toThrow(/hybrid index incomplete.*2 chunks/);
    expect(mockPrisma.document.update.mock.calls.at(-1)?.[0].data.indexReadiness).toBe('degraded');
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
    expect(mockPrisma.document.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'doc-1', version: 4 },
      data: { indexReadiness: 'enriching' },
    }));
  });

  it('stops when a version change races with the enriching state update', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(true);
    mockPrisma.document.findUnique.mockResolvedValue({ version: 4 });
    mockPrisma.document.updateMany.mockResolvedValue({ count: 0 });

    await expect(processor.process(job({ documentId: 'doc-1', kbId: 'kb-1', expectedVersion: 4 })))
      .resolves.toEqual({ readiness: 'superseded' });
    expect(chunkEmbedding.embedDocumentChunks).not.toHaveBeenCalled();
  });

  it('dispatches slow RAPTOR work without delaying core readiness', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(true);
    chunkEmbedding.embedDocumentChunks.mockResolvedValue({ requested: 1, embedded: 1, failed: 0, missing: 0 });
    chunkEmbedding.documentCoverage.mockResolvedValue({ total: 1, missing: 0 });
    mockPrisma.document.findUnique.mockResolvedValue({ version: 4 });
    raptor.isEnabled.mockReturnValue(true);
    raptor.indexDocument.mockResolvedValue(undefined);

    await expect(processor.process(job({ documentId: 'doc-1', kbId: 'kb-1', expectedVersion: 4 })))
      .resolves.toEqual({ readiness: 'ready' });
    expect(mockPrisma.enrichmentStage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { documentId_version_stage: { documentId: 'doc-1', version: 4, stage: 'embedding' } },
    }));
    expect(mockPrisma.brainChangeEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ eventType: 'aux_enrichment_request', resourceId: 'doc-1' }),
    }));
    expect(chunkEmbedding.embedDocumentChunks).toHaveBeenCalledTimes(1);
    expect(raptor.indexDocument).not.toHaveBeenCalled();
  });

  it('completes the durable outbox event only after enrichment succeeds', async () => {
    chunkEmbedding.isEnabled.mockReturnValue(false);
    mockPrisma.document.findUnique.mockResolvedValue({ version: 4 });
    await expect(processor.process(job({
      documentId: 'doc-1', kbId: 'kb-1', expectedVersion: 4, outboxEventId: 'evt-1',
    }))).resolves.toEqual({ readiness: 'ready' });
    expect(mockPrisma.brainChangeEvent.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'evt-1' },
      data: expect.objectContaining({ status: 'completed', processedAt: expect.any(Date) }),
    }));
  });

  it('runs RAPTOR on the auxiliary path and records its completed stage', async () => {
    raptor.isEnabled.mockReturnValue(true);
    raptor.indexDocument.mockResolvedValue({ nodes: 2 });
    mockPrisma.document.findUnique.mockResolvedValue({ version: 4, kb: { status: 'active' } });
    await processor.processAuxiliary(job({ documentId: 'doc-1', kbId: 'kb-1',
      expectedVersion: 4, outboxEventId: 'aux-1' }));
    expect(raptor.indexDocument).toHaveBeenCalledWith('kb-1', 'doc-1');
    expect(mockPrisma.enrichmentStage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ stage: 'raptor' }),
    }));
    expect(mockPrisma.brainChangeEvent.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'aux-1' }, data: expect.objectContaining({ status: 'completed' }),
    }));
  });
});
