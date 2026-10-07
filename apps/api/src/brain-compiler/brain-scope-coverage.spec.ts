import { BrainScopeService } from './brain-scope.service';

const db: any = { brainScope: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() }, brainSource: { findMany: jest.fn() }, brainDerivedPage: { findUnique: jest.fn(), upsert: jest.fn() }, document: { findMany: jest.fn() }, $queryRaw: jest.fn() };
jest.mock('../prisma', () => ({ getPrismaClient: () => db }));

describe('scope source coverage and publication fence', () => {
  const savedFull = process.env.BRAIN_SCOPE_FULL_COVERAGE;
  const savedSynthesis = process.env.GBRAIN_SCOPE_SYNTHESIZE_ENABLED;
  const sources = Array.from({ length: 6 }, (_, index) => `source-${index}`);
  const scope = { id: 'scope', fingerprint: 'fingerprint', status: 'dirty', sourceKeys: sources, aclEpoch: 1, knowledgeEpoch: 2 };
  const docs = Array.from({ length: 6 }, (_, index) => ({ id: `doc-${index}`, title: `Document ${index}`, status: 'published', kb: { name: 'KB' }, version: 1, activeVersionId: `version-${index}`, contentHash: `hash-${index}`, chunks: Array.from({ length: 41 }, (_, ord) => ({ id: `chunk-${index}-${ord}`, ord, content: `content ${ord}` })) }));
  let adapter: any;
  beforeEach(() => {
    jest.clearAllMocks(); delete process.env.BRAIN_SCOPE_FULL_COVERAGE; process.env.GBRAIN_SCOPE_SYNTHESIZE_ENABLED = '1';
    db.brainScope.findUnique.mockResolvedValue(scope);
    db.brainScope.updateMany.mockResolvedValue({ count: 1 });
    db.brainSource.findMany.mockResolvedValue(docs.map((document, index) => ({ sourceKey: sources[index], documents: [{ document }] })));
    db.brainDerivedPage.findUnique.mockResolvedValue(null);
    db.document.findMany.mockResolvedValue(docs);
    db.$queryRaw.mockResolvedValue([{ sourceDocumentId: 'doc-0', targetDocumentId: 'doc-1', similarity: 0.8 }]);
    adapter = { synthesize: jest.fn().mockResolvedValue({ answer: 'Supported source summary' }), initializeSource: jest.fn(), ingest: jest.fn() };
  });
  afterAll(() => {
    if (savedFull === undefined) delete process.env.BRAIN_SCOPE_FULL_COVERAGE; else process.env.BRAIN_SCOPE_FULL_COVERAGE = savedFull;
    if (savedSynthesis === undefined) delete process.env.GBRAIN_SCOPE_SYNTHESIZE_ENABLED; else process.env.GBRAIN_SCOPE_SYNTHESIZE_ENABLED = savedSynthesis;
  });
  const service = () => new BrainScopeService({} as any, undefined, adapter);
  it('covers sources beyond five and chunks beyond forty, publishes audit/timeline/semantic pages', async () => {
    const result = await service().compileScopeDerived('scope');
    expect(adapter.synthesize).toHaveBeenCalledTimes(6);
    const chunkQuery = db.brainSource.findMany.mock.calls[0][0].include.documents.include.document.include.chunks;
    expect(chunkQuery.take).toBeUndefined();
    expect(result.derivedPagesCount).toBe(4);
    const pages = db.brainDerivedPage.upsert.mock.calls.map((call: any) => call[0].create);
    expect(pages.find((page: any) => page.kind === 'graph').content).toContain('vector similarity is navigation');
    expect(pages[0].derivedFrom[0]).toMatchObject({ chunkCount: 41, coverage: 'complete', documentVersionId: 'version-0' });
    expect(adapter.ingest.mock.calls[0][1].map((page: any) => page.slug)).toEqual(['derived/scope-summary', 'derived/timeline', 'derived/topic-relations']);
  });
  it('rejects source replacement during synthesis before persisting pages', async () => {
    db.document.findMany.mockResolvedValue(docs.map(doc => ({ ...doc, version: 2 })));
    await expect(service().compileScopeDerived('scope')).rejects.toThrow('inputs changed');
    expect(db.brainDerivedPage.upsert).not.toHaveBeenCalled();
    expect(adapter.ingest).not.toHaveBeenCalled();
  });
  it('rejects epoch invalidation before publishing an active scope', async () => {
    db.brainScope.updateMany.mockImplementation(async (args: any) => ({ count: args.data.status === 'active' ? 0 : 1 }));
    await expect(service().compileScopeDerived('scope')).rejects.toThrow('epochs changed');
  });
  it('retains an explicit bounded mode without labeling its inventory complete', async () => {
    process.env.BRAIN_SCOPE_FULL_COVERAGE = '0';
    await service().compileScopeDerived('scope');
    expect(adapter.synthesize).toHaveBeenCalledTimes(5);
    expect(db.brainSource.findMany.mock.calls[0][0].include.documents.include.document.include.chunks.take).toBe(40);
    expect(db.brainDerivedPage.upsert.mock.calls[0][0].create.derivedFrom[0].coverage).toBe('bounded');
  });
});
