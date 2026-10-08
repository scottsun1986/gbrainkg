import { runWithRequestContext } from '../observability/request-context';
import { CitationAssemblyService } from './citation-assembly';

describe('CitationAssemblyService ACL revalidation', () => {
  const guard = { scopeId: 'scope', sourceKeys: ['kb-1'], aclEpoch: 1, knowledgeEpoch: 1, userId: 'reader' };

  function createService(readableIds: string[], restrictedDocs: Array<{ documentId: string; document: { kbId: string } }> = []) {
    const prisma = {
  $transaction: jest.fn(async (fn: any) => fn({})),
      document: { findMany: jest.fn().mockResolvedValue([]) },
      blockArtifact: { findMany: jest.fn().mockResolvedValue([]) },
      documentAcl: { findMany: jest.fn().mockResolvedValue(restrictedDocs) },
      brainDerivedPage: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const acl = { filterReadableDocuments: jest.fn().mockResolvedValue(new Set(readableIds)) };
    const service = new CitationAssemblyService({
      logger: { warn: jest.fn() } as any,
      prisma,
      documentAclService: acl as any,
    });
    return { service, prisma, acl };
  }

  it('cites every byte-identical duplicate of a cited document', async () => {
    const prisma = {
      document: { findMany: jest.fn() },
    };
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-a', kbId: 'kb-1', contentHash: 'hash-1' }])
      .mockResolvedValueOnce([
        { id: 'doc-a', kbId: 'kb-1', title: 'A.doc', version: 1, contentHash: 'hash-1', aclMode: 'inherit' },
        { id: 'doc-b', kbId: 'kb-1', title: 'A (副本).doc', version: 1, contentHash: 'hash-1', aclMode: 'inherit' },
      ]);
    const acl = { filterReadableDocuments: jest.fn().mockResolvedValue(new Set(['doc-a', 'doc-b'])) };
    const service = new CitationAssemblyService({
      logger: { warn: jest.fn(), debug: jest.fn() } as any,
      prisma,
      documentAclService: acl as any,
    });
    const result = await (service as any).expandIdenticalContentCitations(
      'user-1',
      [{ citation: { docId: 'doc-a', docTitle: 'A.doc' }, originalIndex: 1 }],
      ['kb-1'],
    );
    expect(result.citations).toHaveLength(2);
    expect(result.citations[1].citation.docId).toBe('doc-b');
    expect(result.citations[1].citation.docTitle).toBe('A (副本).doc');
    expect(result.siblingIndicesByIndex.get(1)).toEqual([2]);
  });

  it('does not add an identical duplicate the caller may not read', async () => {
    const prisma = {
      document: { findMany: jest.fn() },
    };
    prisma.document.findMany
      .mockResolvedValueOnce([{ id: 'doc-a', kbId: 'kb-1', contentHash: 'hash-1' }])
      .mockResolvedValueOnce([
        { id: 'doc-a', kbId: 'kb-1', title: 'A.doc', version: 1, contentHash: 'hash-1', aclMode: 'inherit' },
        { id: 'doc-b', kbId: 'kb-1', title: 'A (副本).doc', version: 1, contentHash: 'hash-1', aclMode: 'restricted' },
      ]);
    const acl = { filterReadableDocuments: jest.fn().mockResolvedValue(new Set(['doc-a'])) };
    const service = new CitationAssemblyService({
      logger: { warn: jest.fn(), debug: jest.fn() } as any,
      prisma,
      documentAclService: acl as any,
    });
    const result = await (service as any).expandIdenticalContentCitations(
      'user-1',
      [{ citation: { docId: 'doc-a', docTitle: 'A.doc' }, originalIndex: 1 }],
      ['kb-1'],
    );
    expect(result.citations).toHaveLength(1);
    expect(result.siblingIndicesByIndex.size).toBe(0);
  });

  it('does not repeat broad retrieval solely because a completed reranker lacks calibration', () => {
    const { service } = createService([]);
    runWithRequestContext({requestId:'uncalibrated', execution:{adaptive:true,qualityFirst:true} as any}, () => {
      const result = service.assessWeakEvidence({reranked:true,citations:[{docId:'doc',evidence:'original',rerankScore:0.95}]});
      expect(result.shouldEscalate).toBe(false);
      expect(result.topScore).toBeNull();
      expect(service.assessWeakEvidence({reranked:true,citations:[]}).shouldEscalate).toBe(true);
      expect(service.assessWeakEvidence({reranked:true,citations:[{calibratedProbability:0.1}]}).shouldEscalate).toBe(true);
    });
  });

  it('hydrates physical block order with authorized originals for pre-selection stitching', async () => {
    const { service, prisma } = createService(['doc']);
    prisma.document.findMany.mockResolvedValue([{ id: 'doc', kbId: 'kb-1', version: 2, activeVersionId: 'v2' }]);
    prisma.blockArtifact.findMany.mockResolvedValue([
      { id: 'block-a', versionId: 'v2', ord: 6, rawHash: 'a', charStart: 0, charEnd: 6, rawContent: 'First.' },
      { id: 'block-b', versionId: 'v2', ord: 7, rawHash: 'b', charStart: 6, charEnd: 13, rawContent: 'Second.' },
    ]);
    const result = await service.filterQueryResultByCurrentPermission({ citations: [
      { docId: 'doc', chunkId: 'block-a', context: 'preview' },
      { docId: 'doc', chunkId: 'block-b', context: 'preview', ord: 999 },
    ] }, ['kb-1'], guard);
    expect(result.citations.map((c: any) => [c.chunkId, c.ord, c.context])).toEqual([
      ['block-a', 6, 'First.'], ['block-b', 7, 'Second.'],
    ]);
    expect(prisma.blockArtifact.findMany.mock.calls[0][0].where.OR).toEqual([
      { versionId: 'v2', id: 'block-a' }, { versionId: 'v2', id: 'block-b' },
    ]);
  });

  it('drops obsolete evidence instead of stamping it with the current version', async () => {
    const { service, prisma } = createService(['doc']);
    prisma.document.findMany.mockResolvedValue([{ id: 'doc', kbId: 'kb-1', version: 2 }]);
    const result = await service.filterQueryResultByCurrentPermission({
      citations: [{ docId: 'doc', version: 1, context: 'old content' }],
    }, ['kb-1'], guard);
    expect(result.citations).toEqual([]);
  });

  it('drops KB-wide summaries when a published source document is unreadable', async () => {
    const { service } = createService([], [{ documentId: 'private-doc', document: { kbId: 'kb-1' } }]);
    const result = await service.filterQueryResultByCurrentPermission({
      citations: [{ raptor: true, kbId: 'kb-1', context: 'private summary' }],
    }, ['kb-1'], guard);
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe('');
  });

  it('retains KB-wide summaries only with a complete readable source manifest', async () => {
    const { service, prisma } = createService(['private-doc'], [{ documentId: 'private-doc', document: { kbId: 'kb-1' } }]);
    prisma.document.findMany.mockResolvedValue([{ id: 'private-doc', kbId: 'kb-1', aclMode: 'restricted' }] as any);
    const result = await service.filterQueryResultByCurrentPermission({
      citations: [{ raptor: true, kbId: 'kb-1', sourceDocumentIds: ['private-doc'], context: 'safe summary' }],
    }, ['kb-1'], guard);
    expect(result.citations).toHaveLength(1);
  });

  it('drops compiled derived pages when their source document is unreadable', async () => {
    const { service, prisma } = createService([]);
    prisma.brainDerivedPage.findMany.mockResolvedValue([{
      slug: 'derived', sourceKeys: ['kb-1'], derivedFrom: [{ docId: 'private-doc' }],
    }]);
    prisma.document.findMany.mockResolvedValue([{ id: 'private-doc', kbId: 'kb-1' }]);
    const result = await service.filterQueryResultByCurrentPermission({
      citations: [{ isCompiledDerived: true, scopeId: 'scope', aclEpoch: 1, slug: 'derived', context: 'secret' }],
    }, ['kb-1'], guard);
    expect(result.citations).toEqual([]);
  });
});
