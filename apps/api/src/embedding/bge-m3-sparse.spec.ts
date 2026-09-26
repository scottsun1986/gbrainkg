/**
 * BGE-M3 sparse / late-interaction toggles and fail-open behaviour.
 * Kept under embedding/ so the ROI-2 acceptance test pattern picks it up.
 */
import { EmbeddingService } from './embedding.service';
import { HybridRetrievalService } from '../retrieval/hybrid-retrieval.service';

jest.mock('../observability/failopen', () => ({
  recordFailopen: jest.fn(),
}));

const mockPrisma: any = { $queryRaw: jest.fn() };
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));
jest.mock('../prisma', () => ({ getPrismaClient: jest.fn(() => mockPrisma) }));

import { recordFailopen } from '../observability/failopen';

describe('BGE-M3 hybrid enablement', () => {
  const originalFlag = process.env.BGE_M3_HYBRID_ENABLED;
  const originalEndpoint = process.env.BGE_M3_HYBRID_ENDPOINT;
  const originalBaseUrl = process.env.EMBEDDING_BASE_URL;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalFlag === undefined) delete process.env.BGE_M3_HYBRID_ENABLED;
    else process.env.BGE_M3_HYBRID_ENABLED = originalFlag;
    if (originalEndpoint === undefined) delete process.env.BGE_M3_HYBRID_ENDPOINT;
    else process.env.BGE_M3_HYBRID_ENDPOINT = originalEndpoint;
    if (originalBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
    else process.env.EMBEDDING_BASE_URL = originalBaseUrl;
  });

  describe('sparse toggle', () => {
    it('is ON by default (flag unset)', () => {
      delete process.env.BGE_M3_HYBRID_ENABLED;
      expect(new EmbeddingService().isHybridEnabled()).toBe(true);
    });

    it('stays ON when explicitly set to true', () => {
      process.env.BGE_M3_HYBRID_ENABLED = 'true';
      expect(new EmbeddingService().isHybridEnabled()).toBe(true);
    });

    it('turns OFF when explicitly set to false', () => {
      process.env.BGE_M3_HYBRID_ENABLED = 'false';
      expect(new EmbeddingService().isHybridEnabled()).toBe(false);
    });

    it('embedHybrid returns empty representations when the toggle is off', async () => {
      process.env.BGE_M3_HYBRID_ENABLED = 'false';
      const svc = new EmbeddingService();
      await expect(svc.embedHybrid(['x'])).resolves.toEqual([
        { dense: null, sparse: null, multiVector: null },
      ]);
    });
  });

  describe('fail-open when no hybrid endpoint is configured', () => {
    it('embedHybrid fails open and records the degradation', async () => {
      delete process.env.BGE_M3_HYBRID_ENABLED;
      delete process.env.BGE_M3_HYBRID_ENDPOINT;
      delete process.env.EMBEDDING_BASE_URL;
      const isolated = new EmbeddingService({ getDefault: jest.fn().mockResolvedValue(null) } as any);
      await expect(isolated.embedHybrid(['q'])).resolves.toEqual([
        { dense: null, sparse: null, multiVector: null },
      ]);
      expect(recordFailopen).toHaveBeenCalledWith('sparse');
    });

    it('searchSparse fails open + recordFailopen when the query has no sparse arm', async () => {
      delete process.env.BGE_M3_HYBRID_ENABLED;
      const embedding = {
        isHybridEnabled: () => true,
        embedHybridOne: jest.fn().mockResolvedValue({ dense: [1], sparse: null, multiVector: null }),
      } as any;
      const service = new HybridRetrievalService(embedding);
      await expect(service.searchSparse(['kb'], 'query')).resolves.toEqual([]);
      expect(recordFailopen).toHaveBeenCalledWith('sparse');
    });

    it('rerankLateInteraction fails open + recordFailopen without multi-vector', async () => {
      const embedding = {
        isHybridEnabled: () => true,
        embedHybridOne: jest.fn().mockResolvedValue({ dense: [1], sparse: null, multiVector: null }),
      } as any;
      const service = new HybridRetrievalService(embedding);
      const result = await service.rerankLateInteraction('query', ['c1']);
      expect(result.size).toBe(0);
      expect(recordFailopen).toHaveBeenCalledWith('late_interaction');
    });

    it('sparse/late paths stay silent when the feature is disabled', async () => {
      process.env.BGE_M3_HYBRID_ENABLED = 'false';
      const embedding = {
        isHybridEnabled: () => false,
        embedHybridOne: jest.fn(),
      } as any;
      const service = new HybridRetrievalService(embedding);
      await service.searchSparse(['kb'], 'query');
      await service.rerankLateInteraction('query', ['c1']);
      expect(embedding.embedHybridOne).not.toHaveBeenCalled();
      expect(recordFailopen).not.toHaveBeenCalled();
    });

    it('scores learned sparse postings when the hybrid arm is live', async () => {
      const embedding = {
        isHybridEnabled: () => true,
        embedHybridOne: jest.fn().mockResolvedValue({
          dense: null,
          sparse: { indices: [7, 9], values: [1, 0.5] },
          multiVector: null,
        }),
      } as any;
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          chunkId: 'c1', sparseScore: 0.8, documentId: 'd1', kbId: 'k1', ord: 0,
          content: 'source text', metadata: {}, docTitle: 'doc', docVersion: 1,
        },
      ]);
      const service = new HybridRetrievalService(embedding);
      const hits = await service.searchSparse(['k1'], 'query', 5);
      expect(hits).toHaveLength(1);
      expect(hits[0].sparseScore).toBeGreaterThan(0);
      expect(recordFailopen).not.toHaveBeenCalled();
    });
  });
});
