import { GraphRagService } from './graph-rag.service';
import { runWithRequestContext } from '../observability/request-context';
import { filterReadableArtifacts } from '../permission/artifact-read-guard';

const db: any = { graphCommunity: { findMany: jest.fn() }, $queryRaw: jest.fn(), $executeRaw: jest.fn() };
db.$transaction = jest.fn(async (fn, _options?: any) => fn(db));
jest.mock('../prisma', () => ({ getPrismaClient: () => db }));
jest.mock('../permission/artifact-read-guard', () => ({ filterReadableArtifacts: jest.fn() }));

describe('community recall and complete extraction', () => {
  const savedAuth = process.env.CORE_AUTH_ENFORCE;
  const savedFull = process.env.GRAPH_LLM_FULL_EXTRACTION;
  beforeEach(() => { jest.clearAllMocks(); process.env.CORE_AUTH_ENFORCE = '0'; delete process.env.GRAPH_LLM_FULL_EXTRACTION; });
  afterAll(() => {
    if (savedAuth === undefined) delete process.env.CORE_AUTH_ENFORCE; else process.env.CORE_AUTH_ENFORCE = savedAuth;
    if (savedFull === undefined) delete process.env.GRAPH_LLM_FULL_EXTRACTION; else process.env.GRAPH_LLM_FULL_EXTRACTION = savedFull;
  });
  it('ranks a relevant older community without pre-truncating latest rows', async () => {
    db.graphCommunity.findMany.mockResolvedValue([{ id: 'old', title: 'Alpha', summary: 'Useful Alpha', findings: [] }]);
    const result = await new GraphRagService().searchGlobalCommunities(['kb'], 'Alpha', 1);
    expect(result.communities[0].id).toBe('old');
    expect(db.graphCommunity.findMany.mock.calls[0][0].take).toBeUndefined();
    expect(db.graphCommunity.findMany.mock.calls[0][0].where.OR.length).toBeGreaterThan(0);
  });
  it('retains unembedded lexical hits alongside vector results', async () => {
    const embedding: any = { isEnabled: () => true, embedOne: jest.fn().mockResolvedValue([1, 0]) };
    db.$queryRaw.mockResolvedValue([{ id: 'dense', title: 'related', summary: 'vector hit', similarity: 0.8 }]);
    db.graphCommunity.findMany.mockResolvedValue([{ id: 'lexical', title: 'Alpha', summary: 'Alpha source' }]);
    const result = await new GraphRagService(embedding).searchGlobalCommunities(['kb'], 'Alpha', 2);
    expect(result.communities.map(row => row.id).sort()).toEqual(['dense', 'lexical']);
  });
  it('converges artifact authority before either recall arm can apply LIMIT', async () => {
    process.env.CORE_AUTH_ENFORCE = '1';
    db.graphCommunity.findMany.mockResolvedValueOnce([{ id: 'readable', kbId: 'kb' }, { id: 'denied', kbId: 'kb' }]).mockResolvedValueOnce([{ id: 'readable', title: 'Alpha', summary: 'Alpha' }]);
    (filterReadableArtifacts as jest.Mock).mockResolvedValue(new Set(['readable']));
    const result = await runWithRequestContext({ requestId: 'test', userId: 'user' }, () => new GraphRagService().searchGlobalCommunities(['kb'], 'Alpha', 1));
    expect(result.communities[0].id).toBe('readable');
    expect(db.graphCommunity.findMany.mock.calls[1][0].where.id.in).toEqual(['readable']);
    expect(filterReadableArtifacts).toHaveBeenCalledWith('user', expect.any(Array), 'GraphCommunity', db);
    expect(db.$transaction.mock.calls[0][1].isolationLevel).toBe('RepeatableRead');
    expect((await new GraphRagService().searchGlobalCommunities(['kb'], 'Alpha')).communities).toEqual([]);
  });
  it('full mode extracts the tail and overrides sampled options', async () => {
    process.env.GRAPH_LLM_FULL_EXTRACTION = '1';
    const service = new GraphRagService();
    const extract = jest.spyOn(service, 'extractEntitiesWithLLM').mockResolvedValue({ entities: [], relations: [] });
    await service.extractGraphElementsHybrid('Doc', 'doc', [{ id: 'chunk', content: 'x'.repeat(5000) + 'TAIL' }], 1, { baseUrl: 'route', apiKey: '', modelName: 'model' }, { llmSampleRate: 0.1, maxLlmChunks: 1 });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls[1][0]).toContain('TAIL');
    await expect(service.extractGraphElementsHybrid('Doc', 'doc', [], 1, null)).rejects.toThrow('configured LLM');
    extract.mockRejectedValueOnce(new Error('provider failure'));
    await expect(service.extractGraphElementsHybrid('Doc', 'doc', [{ content: 'real text' }], 1, { baseUrl: 'route', apiKey: '', modelName: 'model' })).rejects.toThrow('provider failure');
  });
});
