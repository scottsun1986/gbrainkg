import { KnowledgeGraphController } from './knowledge-graph.controller';
import { ForbiddenException } from '@nestjs/common';

const mockFindMany = jest.fn().mockResolvedValue([]);
const mockAggregate = jest.fn().mockResolvedValue({ _count: 0, _max: { updatedAt: null } });
const mockGetLinks = jest.fn();
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => ({ document: { findMany: mockFindMany, aggregate: mockAggregate } })) }));
jest.mock('@llmwiki/gbrain-adapter', () => ({ BrainRepoAdapter: jest.fn(() => ({ getLinks: mockGetLinks })) }));

describe('graph rebuild authorization', () => {
  const auth = { userIdFromRequest: jest.fn().mockResolvedValue('reader') };
  const permission = {
    getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['read-only', 'managed']),
    canManageKnowledgeBase: jest.fn(async (_user: string, kb: string) => kb === 'managed'),
  };
  const graph = { buildCommunitiesForKb: jest.fn() };
  beforeEach(() => jest.clearAllMocks());
  it('reads only published scoped documents and hides unknown upstream targets', async () => {
    mockFindMany.mockResolvedValueOnce([{
      id: 'doc-1', kbId: 'managed', title: 'Current', updatedAt: new Date(),
      kb: { id: 'managed', name: 'Library', type: 'organization' }, chunks: [],
    }]);
    mockGetLinks.mockResolvedValueOnce([{ to: 'docs/deleted', title: 'PRIVATE_OLD_TITLE', context: 'PRIVATE_OLD_SNIPPET' }]);
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any);
    const result = await controller.getGraph({});
    expect(mockFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { kbId: { in: ['read-only', 'managed'] }, status: 'published' } }));
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OLD');
    expect(result.stats.gbrainLinksFiltered).toBe(1);
    expect(graph.buildCommunitiesForKb).not.toHaveBeenCalled();
  });
  it('rejects a visible but read-only library without database work', async () => {
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any);
    await expect(controller.reindexGraph({}, 'read-only')).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(graph.buildCommunitiesForKb).not.toHaveBeenCalled();
  });
  it('bulk rebuild includes only manageable libraries', async () => {
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any);
    const result = await controller.reindexGraph({});
    expect(result.kbs).toEqual(['managed']);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kbId: { in: ['managed'] }, status: 'published' } }));
    expect(graph.buildCommunitiesForKb).toHaveBeenCalledTimes(1);
    expect(graph.buildCommunitiesForKb).toHaveBeenCalledWith('managed');
  });

  it('serves repeat views from the content-aware cache without rescanning', async () => {
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any);
    const first = await controller.getGraph({});
    const scansAfterFirst = mockFindMany.mock.calls.length;
    expect(first.cached).toBeUndefined();
    const second = await controller.getGraph({});
    expect(second.cached).toBe(true);
    expect(mockFindMany.mock.calls.length).toBe(scansAfterFirst);
  });
});
