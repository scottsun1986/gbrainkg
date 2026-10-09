import { KnowledgeBaseController } from './knowledge-base.controller';

const mockPrisma: any = {
  knowledgeBase: {
    count: jest.fn(), findFirst: jest.fn(), create: jest.fn(),
  },
  document: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  user: { findMany: jest.fn() },
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('personal knowledge base creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.knowledgeBase.findFirst.mockResolvedValue(null);
    mockPrisma.knowledgeBase.create.mockResolvedValue({ id: 'kb-new', _count: { documents: 0 } });
  });

  it('allows creating a personal knowledge base without a numeric count limit', async () => {
    const permission = { invalidatePermissionCaches: jest.fn() };
    const controller = new KnowledgeBaseController(
      permission as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any,
      { queueAccessReconciliation: jest.fn().mockResolvedValue(undefined) } as any,
    );
    await expect(controller.createPersonalKnowledgeBase({} as any, { name: 'extra KB' }))
      .resolves.toMatchObject({ knowledgeBase: { id: 'kb-new', documentCount: 0 } });
    expect(mockPrisma.knowledgeBase.count).not.toHaveBeenCalled();
    expect(mockPrisma.knowledgeBase.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'extra KB', ownerUserId: 'user-1' }),
    }));
  });

  it('invalidates the owner visibility cache so the new KB is immediately usable', async () => {
    const permission = { invalidatePermissionCaches: jest.fn() };
    const controller = new KnowledgeBaseController(
      permission as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any,
      { queueAccessReconciliation: jest.fn().mockResolvedValue(undefined) } as any,
    );
    await controller.createPersonalKnowledgeBase({} as any, { name: 'immediately usable' });
    // Creation must drop the cached visible-KB set for the owner, otherwise an
    // immediate documents/list call returned 403 for up to PERMISSION_CACHE_TTL_MS.
    expect(permission.invalidatePermissionCaches).toHaveBeenCalledWith('user-1');
  });
});

describe('personal knowledge base deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.knowledgeBase.findUnique = jest.fn().mockResolvedValue({
      id: 'kb-1', type: 'personal', ownerUserId: 'user-1', status: 'active',
    });
    mockPrisma.knowledgeBase.update = jest.fn().mockResolvedValue({ id: 'kb-1', status: 'archived' });
  });

  it('invalidates the owner visibility cache after archiving', async () => {
    const permission = { invalidatePermissionCaches: jest.fn() };
    const controller = new KnowledgeBaseController(
      permission as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any,
      { queueAccessReconciliation: jest.fn().mockResolvedValue(undefined) } as any,
    );
    await controller.deletePersonalKnowledgeBase({} as any, 'kb-1');
    expect(mockPrisma.knowledgeBase.update).toHaveBeenCalledWith({
      where: { id: 'kb-1' }, data: { status: 'archived' },
    });
    expect(permission.invalidatePermissionCaches).toHaveBeenCalledWith('user-1');
  });
});

describe('document list pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.document.findMany.mockResolvedValue([]);
    mockPrisma.document.count.mockResolvedValue(300);
    mockPrisma.document.groupBy.mockResolvedValue([
      { status: 'published', _count: { _all: 300 } },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([]);
  });

  it('uses a unique tie-break and whole-KB status counts across pages', async () => {
    const controller = new KnowledgeBaseController(
      { getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['kb-1']) } as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any,
      {} as any,
    );
    const page = await controller.listDocuments('kb-1', {}, undefined, undefined, undefined, '2', '100');
    expect(mockPrisma.document.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 100,
      take: 100,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    }));
    expect(page.statusCounts).toMatchObject({ total: 300, published: 300, processing: 0 });
  });
});

describe('document list ACL boundary', () => {
  it('filters population before pagination and omits private storage paths', async () => {
    const { DocumentAclService } = await import('../permission/document-acl.service');
    const acl = jest.spyOn(DocumentAclService.prototype, 'filterReadableDocuments').mockResolvedValue(new Set(['allowed']));
    mockPrisma.document.findMany.mockImplementation(async (input: any) => input.select && Object.keys(input.select).length === 1
      ? [{ id: 'allowed' }, { id: 'restricted' }]
      : [{ id: 'allowed', title: 'public', rawFileOid: '/private/source', status: 'published', version: 1, updatedAt: new Date() }]);
    mockPrisma.document.count.mockResolvedValue(1);
    mockPrisma.document.groupBy.mockResolvedValue([{ status: 'published', _count: { _all: 1 } }]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    const controller = new KnowledgeBaseController(
      { getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['kb-1']) } as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any, {} as any,
    );
    try {
      const result = await controller.listDocuments('kb-1', {});
      expect(mockPrisma.document.count).toHaveBeenCalledWith({ where: { AND: [{ kbId: 'kb-1' }, { id: { in: ['allowed'] } }] } });
      expect(result.items[0].rawFileOid).toBeUndefined();
    } finally { acl.mockRestore(); }
  });
});

describe('single document authorization', () => {
  const kbId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const docId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  it('applies document ACL, not just knowledge base visibility', async () => {
    const { DocumentAclService } = await import('../permission/document-acl.service');
    const acl = jest.spyOn(DocumentAclService.prototype, 'filterReadableDocuments').mockResolvedValue(new Set());
    mockPrisma.document.findFirst = jest.fn().mockResolvedValue({
      id: docId, kbId, chunks: [], title: 'restricted', status: 'published', version: 1,
      parserMetadata: { structured_tables: [{ id: 't', rows: [{ row: 1, cells: [{ column: 1, value: 'secret' }] }] }] },
    });
    const controller = new KnowledgeBaseController(
      { getVisibleKnowledgeBases: jest.fn().mockResolvedValue([kbId]) } as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('user-1') } as any, {} as any,
    );
    try {
      // KB visibility alone must not expose chunks, raw Markdown or full
      // parserMetadata (which now carries every structured table cell).
      await expect(controller.getDocument(kbId, docId, {} as any)).rejects.toThrow('Document not found.');
      expect(mockPrisma.document.findFirst).not.toHaveBeenCalled();
    } finally { acl.mockRestore(); }
  });
});

describe('preview file current authorization', () => {
  const kbId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const docId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  beforeAll(() => { process.env.PREVIEW_TOKEN_SECRET = 'preview-test-secret-at-least-32-characters'; });
  afterAll(() => { delete process.env.PREVIEW_TOKEN_SECRET; });
  it('denies a disabled user with an otherwise valid file token', async () => {
    const { signPreviewPayload } = await import('../auth/document-preview-token');
    mockPrisma.user.findUnique = jest.fn().mockResolvedValue({ status: 'disabled' });
    const permission = { getVisibleKnowledgeBases: jest.fn().mockResolvedValue([kbId]) };
    const controller = new KnowledgeBaseController(permission as any, {} as any, {} as any);
    const token = signPreviewPayload({ userId: 'user', kbId, docId, version: 1, exp: Math.floor(Date.now() / 1000) + 60 });
    await expect(controller.getPreviewFile(kbId, docId, token, {} as any)).rejects.toThrow('Preview user is inactive');
    expect(permission.getVisibleKnowledgeBases).not.toHaveBeenCalled();
  });
  it('denies a revoked document ACL before opening the source file', async () => {
    const { signPreviewPayload } = await import('../auth/document-preview-token');
    const { DocumentAclService } = await import('../permission/document-acl.service');
    mockPrisma.user.findUnique = jest.fn().mockResolvedValue({ status: 'active' });
    const acl = jest.spyOn(DocumentAclService.prototype, 'isDocumentReadable').mockResolvedValue(false);
    const controller = new KnowledgeBaseController({ getVisibleKnowledgeBases: jest.fn().mockResolvedValue([kbId]) } as any, {} as any, {} as any);
    try {
      const token = signPreviewPayload({ userId: 'user', kbId, docId, version: 1, exp: Math.floor(Date.now() / 1000) + 60 });
      await expect(controller.getPreviewFile(kbId, docId, token, {} as any)).rejects.toThrow('Preview access is no longer authorized');
    } finally { acl.mockRestore(); }
  });
});
