import { BrainScopeService } from './brain-scope.service';

const db: any = { brainScope: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() }, brainSource: { findMany: jest.fn() }, brainSourceDocument: { findMany: jest.fn() }, brainDerivedPage: { findUnique: jest.fn(), upsert: jest.fn() }, document: { findMany: jest.fn() }, chunk: { findMany: jest.fn() }, $queryRaw: jest.fn() };
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
    db.brainSource.findMany.mockImplementation(async () => sources.map((sourceKey, index) => ({ id: `source-id-${index}`, sourceKey })));
    db.brainSourceDocument.findMany.mockImplementation(async (args: any) => { const index = Number(args.where.sourceId.split('-').pop()); return [{ documentId: docs[index].id, document: docs[index] }]; });
    db.brainDerivedPage.findUnique.mockResolvedValue(null);
    db.document.findMany.mockResolvedValue(docs);
    db.chunk.findMany.mockImplementation(async (args: any) => docs.find(doc => doc.id === args.where.documentId)?.chunks || []);
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
    const chunkQuery = db.brainSourceDocument.findMany.mock.calls[0][0].include.document.include.chunks;
    expect(chunkQuery.take).toBe(4);
    expect(db.chunk.findMany).toHaveBeenCalledTimes(6);
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
    expect(db.brainSourceDocument.findMany.mock.calls[0][0].include.document.include.chunks.take).toBe(40);
    expect(db.brainDerivedPage.upsert.mock.calls[0][0].create.derivedFrom[0].coverage).toBe('bounded');
  });
  it('keeps the complete source inventory across metadata pages', async () => {
    const many = Array.from({ length: 201 }, (_, index) => ({ ...docs[0], id: `document-${String(index).padStart(4, '0')}`, chunks: [] }));
    db.brainScope.findUnique.mockResolvedValue({ ...scope, sourceKeys: ['source-0'] });
    db.brainSource.findMany.mockResolvedValue([{ id: 'source-id-0', sourceKey: 'source-0' }]);
    db.brainSourceDocument.findMany.mockImplementation(async (args: any) => {
      const after = args.where.documentId?.gt;
      return many.filter(document => !after || document.id > after).slice(0, args.take).map(document => ({ documentId: document.id, document }));
    });
    db.document.findMany.mockResolvedValue(many);
    db.chunk.findMany.mockResolvedValue([]);
    await service().compileScopeDerived('scope');
    expect(db.brainSourceDocument.findMany).toHaveBeenCalledTimes(2);
    expect(db.brainSourceDocument.findMany.mock.calls[1][0].where.documentId.gt).toBe('document-0199');
    expect(db.brainDerivedPage.upsert.mock.calls[0][0].create.derivedFrom).toHaveLength(201);
  });

});
