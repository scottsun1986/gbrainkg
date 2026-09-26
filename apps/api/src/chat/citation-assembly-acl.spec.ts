import { CitationAssemblyService } from './citation-assembly';

describe('CitationAssemblyService ACL revalidation', () => {
  const guard = { scopeId: 'scope', sourceKeys: ['kb-1'], aclEpoch: 1, knowledgeEpoch: 1, userId: 'reader' };

  function createService(readableIds: string[], restrictedDocs: Array<{ documentId: string; document: { kbId: string } }> = []) {
    const prisma = {
      document: { findMany: jest.fn().mockResolvedValue([]) },
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

  it('drops KB-wide summaries when a published source document is unreadable', async () => {
    const { service } = createService([], [{ documentId: 'private-doc', document: { kbId: 'kb-1' } }]);
    const result = await service.filterQueryResultByCurrentPermission({
      citations: [{ raptor: true, kbId: 'kb-1', context: 'private summary' }],
    }, ['kb-1'], guard);
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe('');
  });

  it('retains KB-wide summaries when all ACL-restricted sources are readable', async () => {
    const { service } = createService(['private-doc'], [{ documentId: 'private-doc', document: { kbId: 'kb-1' } }]);
    const result = await service.filterQueryResultByCurrentPermission({
      citations: [{ raptor: true, kbId: 'kb-1', context: 'safe summary' }],
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
