import { HybridRetrievalService, lateInteractionScore } from './hybrid-retrieval.service';

const mockPrisma = { $queryRaw: jest.fn() };
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('BGE-M3 hybrid retrieval', () => {
  it('computes ColBERT MaxSim over query and document token vectors', () => {
    const score = lateInteractionScore(
      [[1, 0], [0, 1]],
      [[0.9, 0.1], [0.1, 0.9]],
    );
    expect(score).toBeGreaterThan(0.99);
    expect(lateInteractionScore([], [[1, 0]])).toBe(0);
  });

  it('stays disabled without an explicitly compatible hybrid endpoint', async () => {
    const embedding = {
      isHybridEnabled: () => false,
      embedHybridOne: jest.fn(),
    } as any;
    const service = new HybridRetrievalService(embedding);
    await expect(service.searchSparse(['kb'], 'query')).resolves.toEqual([]);
    expect(embedding.embedHybridOne).not.toHaveBeenCalled();
  });

  it('scores learned sparse postings and keeps the ACL-filtered chunk payload', async () => {
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
        chunkId: 'c1', tokenId: 7, weight: 0.8, documentId: 'd1', kbId: 'k1', ord: 0,
        content: 'source text', metadata: {}, docTitle: 'doc', docVersion: 1,
      },
      {
        chunkId: 'c1', tokenId: 9, weight: 0.4, documentId: 'd1', kbId: 'k1', ord: 0,
        content: 'source text', metadata: {}, docTitle: 'doc', docVersion: 1,
      },
    ]);
    const service = new HybridRetrievalService(embedding);
    const hits = await service.searchSparse(['k1'], 'query', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].sparseScore).toBeCloseTo(1.0);
    expect(hits[0].content).toBe('source text');
  });
});
