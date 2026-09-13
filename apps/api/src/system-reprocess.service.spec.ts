import { SystemReprocessService } from './system-reprocess.service';

const mockPrisma = {
  document: {
    count: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  chunk: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  graphEntity: { count: jest.fn() },
  graphRelation: { count: jest.fn() },
  graphCommunity: { count: jest.fn() },
  raptorNode: { count: jest.fn() },
  semanticCache: {
    count: jest.fn(),
    deleteMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

jest.mock('./prisma', () => ({
  getPrismaClient: jest.fn(() => mockPrisma),
}));

describe('SystemReprocessService', () => {
  let service: SystemReprocessService;
  const mockChunkEmbedding = {
    embedDocumentChunks: jest.fn().mockResolvedValue({ requested: 5, embedded: 5, failed: 0, missing: 0 }),
  };
  const mockGraphRag = {
    extractGraphElementsHybrid: jest.fn().mockResolvedValue({ entities: [{ name: 'E1', type: 'concept' }], relations: [] }),
    persistGraphElements: jest.fn().mockResolvedValue({ entityCount: 1, relationCount: 0 }),
    buildCommunitiesForKb: jest.fn().mockResolvedValue(1),
  };
  const mockRaptor = {
    isEnabled: jest.fn().mockReturnValue(true),
    indexDocument: jest.fn().mockResolvedValue(undefined),
    scheduleBuildKbGlobalTree: jest.fn(),
  };
  const mockBrainCompiler = {
    onKnowledgePublished: jest.fn().mockResolvedValue(undefined),
    queueAccessReconciliation: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SystemReprocessService(
      mockChunkEmbedding as any,
      undefined,
      mockGraphRag as any,
      mockRaptor as any,
      mockBrainCompiler as any,
    );
  });

  it('provides initial idle status', () => {
    const status = service.getStatus();
    expect(status.running).toBe(false);
    expect(status.progress).toBe(0);
    expect(status.currentStep).toContain('空闲');
  });

  it('gathers corpus statistics correctly', async () => {
    mockPrisma.document.count.mockResolvedValueOnce(10).mockResolvedValueOnce(8).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    mockPrisma.chunk.count.mockResolvedValue(50);
    mockPrisma.$queryRaw.mockResolvedValue([{ with_vector: BigInt(45), without_vector: BigInt(5) }]);
    mockPrisma.graphEntity.count.mockResolvedValue(100);
    mockPrisma.graphRelation.count.mockResolvedValue(120);
    mockPrisma.graphCommunity.count.mockResolvedValue(4);
    mockPrisma.raptorNode.count.mockResolvedValue(15);
    mockPrisma.semanticCache.count.mockResolvedValue(3);

    const stats = await service.getCorpusStatistics();
    expect(stats.totalDocuments).toBe(10);
    expect(stats.readyDocuments).toBe(8);
    expect(stats.totalChunks).toBe(50);
    expect(stats.chunksWithEmbedding).toBe(45);
    expect(stats.chunksMissingEmbedding).toBe(5);
    expect(stats.totalGraphEntities).toBe(100);
    expect(stats.totalGraphRelations).toBe(120);
    expect(stats.totalGraphCommunities).toBe(4);
    expect(stats.totalRaptorNodes).toBe(15);
    expect(stats.semanticCacheCount).toBe(3);
  });

  it('starts reprocessing in background and executes pipeline', async () => {
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'doc-1', kbId: 'kb-1', title: '测试文档.md', version: 1 },
    ]);
    mockPrisma.chunk.findMany.mockResolvedValue([
      { id: 'c-1', content: '第一章 内容' },
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([{ count: BigInt(0) }]);
    mockPrisma.semanticCache.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.raptorNode.count.mockResolvedValue(2);

    const res = await service.startReprocess({
      embeddings: true,
      graphRag: true,
      raptor: true,
      brainCompile: true,
      alignReadiness: true,
      clearCache: true,
    });

    expect(res.started).toBe(true);
    expect(service.getStatus().running).toBe(true);

    // Wait for setImmediate pipeline execution
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockChunkEmbedding.embedDocumentChunks).toHaveBeenCalledWith('doc-1');
    expect(mockGraphRag.extractGraphElementsHybrid).toHaveBeenCalled();
    expect(mockGraphRag.persistGraphElements).toHaveBeenCalled();
    expect(mockGraphRag.buildCommunitiesForKb).toHaveBeenCalledWith('kb-1');
    expect(mockRaptor.indexDocument).toHaveBeenCalledWith('kb-1', 'doc-1');
    expect(mockBrainCompiler.onKnowledgePublished).toHaveBeenCalled();
    expect(mockBrainCompiler.queueAccessReconciliation).toHaveBeenCalled();
    expect(mockPrisma.semanticCache.deleteMany).toHaveBeenCalled();

    const finalStatus = service.getStatus();
    expect(finalStatus.running).toBe(false);
    expect(finalStatus.progress).toBe(100);
    expect(finalStatus.error).toBeNull();
    expect(finalStatus.stats.scannedDocs).toBe(1);
  });

  it('handles cancel request gracefully', () => {
    expect(service.cancelReprocess().success).toBe(false);
  });
});
