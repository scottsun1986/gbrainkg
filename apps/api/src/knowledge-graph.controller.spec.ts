import { KnowledgeGraphController } from './knowledge-graph.controller';
import { ForbiddenException } from '@nestjs/common';

const mockFindMany = jest.fn().mockResolvedValue([]);
const mockAggregate = jest.fn().mockResolvedValue({ _count: 0, _max: { updatedAt: null } });
const mockGetLinks = jest.fn();
const mockReadable = jest.fn(async (_user: string, ids: string[]) => new Set(ids));
jest.mock('./permission/authorization-revision', () => ({ readAuthorizationSnapshot: jest.fn().mockResolvedValue({ revision: 'test', expiresAt: Infinity }), assertAuthorizationSnapshot: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => ({ document: { findMany: (args: any) => args.where?.AND?.some((part: any) => part.sourceType === 'qa') ? Promise.resolve([]) : mockFindMany(args), aggregate: mockAggregate } })) }));
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
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    const result = await controller.getGraph({});
    expect(mockFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { AND: [expect.objectContaining({ kbId: { in: ['read-only', 'managed'] }, status: 'published', AND: expect.any(Array) }), {}] } }));
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OLD');
    expect(result.stats.gbrainLinksFiltered).toBe(1);
    expect(graph.buildCommunitiesForKb).not.toHaveBeenCalled();
  });
  it('rejects a visible but read-only library without database work', async () => {
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    await expect(controller.reindexGraph({}, 'read-only')).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(graph.buildCommunitiesForKb).not.toHaveBeenCalled();
  });
  it('bulk rebuild includes only manageable libraries', async () => {
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    const result = await controller.reindexGraph({});
    expect(result.kbs).toEqual(['managed']);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kbId: { in: ['managed'] }, status: 'published' } }));
    expect(graph.buildCommunitiesForKb).toHaveBeenCalledTimes(1);
    expect(graph.buildCommunitiesForKb).toHaveBeenCalledWith('managed');
  });

  it('serves repeat views from the content-aware cache without rescanning', async () => {
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    const first = await controller.getGraph({});
    const scansAfterFirst = mockFindMany.mock.calls.filter(call => call[0].select.chunks).length;
    expect(first.cached).toBeUndefined();
    const second = await controller.getGraph({});
    expect(second.cached).toBe(true);
    expect(mockFindMany.mock.calls.filter(call => call[0].select.chunks).length).toBe(scansAfterFirst);
  });
  it('rejects an authorization change while upstream link discovery is awaiting', async () => {
    mockFindMany.mockResolvedValueOnce([{
      id: 'doc-1', kbId: 'managed', aclMode: 'inherit', title: 'Current', updatedAt: new Date(),
      kb: { id: 'managed', name: 'Library', type: 'organization' }, chunks: [],
    }]);
    mockGetLinks.mockImplementationOnce(async () => {
      const { assertAuthorizationSnapshot } = await import('./permission/authorization-revision');
      (assertAuthorizationSnapshot as jest.Mock).mockRejectedValueOnce(new ForbiddenException('Authorization changed'));
      return [];
    });
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    await expect(controller.getGraph({})).rejects.toThrow('Authorization changed');
  });

  it('paginates the readable inventory before constructing the graph', async () => {
    mockAggregate.mockResolvedValueOnce({ _count: 4, _max: { updatedAt: null } });
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    const result = await controller.getGraph({}, '1', undefined, '2');
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 1, where: { AND: [expect.objectContaining({ AND: expect.any(Array) }), {}] } }));
    expect(result.pagination).toEqual({ page: 2, limit: 1, total: 4, hasMore: true });
  });
  it('invalidates an unchanged authorization cache when the document version changes', async () => {
    const document = { id: 'doc', kbId: 'managed', title: 'Current', version: 1, activeVersionId: 'v1', contentHash: 'h1', updatedAt: new Date(1), aclMode: 'inherit', kb: { id: 'managed', name: 'KB', type: 'organization' }, chunks: [] };
    mockFindMany.mockResolvedValueOnce([document]);
    mockGetLinks.mockResolvedValue([]);
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    const first = await controller.getGraph({});
    const updated = { ...document, version: 2, activeVersionId: 'v2', contentHash: 'h2' };
    mockFindMany.mockResolvedValueOnce([updated]).mockResolvedValueOnce([updated]);
    const second = await controller.getGraph({});
    expect(second.cached).toBeUndefined();
    expect(second.projectionVersion).not.toBe(first.projectionVersion);
  });
  it('scopes local expansion and exposes only authorized edge provenance', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 'doc', title: 'Topic', chunks: [{ content: '# Topic', metadata: {} }] }]);
    mockFindMany.mockResolvedValueOnce([{ id: 'doc', kbId: 'managed', title: 'Topic', updatedAt: new Date(1), kb: { id: 'managed', name: 'KB', type: 'organization' }, chunks: [{ id: 'chunk', content: '# Topic', metadata: {} }] }]);
    mockGetLinks.mockResolvedValue([]);
    const controller = new KnowledgeGraphController(auth as any, permission as any, graph as any, undefined, undefined, { filterReadableDocuments: mockReadable } as any);
    const result = await controller.getGraph({}, '100', undefined, '0', 'doc:doc');
    expect(result.edges.some((edge: any) => edge.evidence?.some((item: any) => item.documentId === 'doc'))).toBe(true);
    expect(mockFindMany.mock.calls[1][0].where.AND[1].OR[0]).toEqual({ id: 'doc' });
  });

});
