import { DocumentAclService } from './document-acl.service';

const mockPrisma = {
  document: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  documentAcl: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  kbAdmin: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  userRole: {
    findMany: jest.fn(),
  },
  userOrg: {
    findMany: jest.fn(),
  },
  knowledgeBase: {
    findMany: jest.fn(),
  },
};

jest.mock('../prisma', () => ({
  getPrismaClient: () => mockPrisma,
}));

const permissionService = {
  getVisibleKnowledgeBases: jest.fn(),
  isSystemAdmin: jest.fn(),
  canManageKnowledgeBase: jest.fn(),
};

describe('DocumentAclService.isDocumentReadable', () => {
  let service: DocumentAclService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DocumentAclService(permissionService as any);
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1',
      kbId: 'kb-1',
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'doc-1', kbId: 'kb-1' },
    ]);
    mockPrisma.documentAcl.findMany.mockResolvedValue([]);
    mockPrisma.kbAdmin.findFirst.mockResolvedValue(null);
    mockPrisma.kbAdmin.findMany.mockResolvedValue([]);
    mockPrisma.userRole.findMany.mockResolvedValue([]);
    mockPrisma.userOrg.findMany.mockResolvedValue([]);
    mockPrisma.knowledgeBase.findMany.mockResolvedValue([
      { id: 'kb-1', ownerUserId: 'owner-1' },
    ]);
    permissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    permissionService.isSystemAdmin.mockResolvedValue(false);
  });

  it('inherits KB visibility when the document has no ACL rows', async () => {
    const readable = await service.isDocumentReadable('user-1', 'doc-1');
    expect(readable).toBe(true);
    expect(mockPrisma.documentAcl.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId: { in: ['doc-1'] } },
      }),
    );
  });

  it('rejects when KB is not visible and no ACL grants access', async () => {
    permissionService.getVisibleKnowledgeBases.mockResolvedValue([]);
    mockPrisma.documentAcl.findMany.mockResolvedValue([
      { documentId: 'doc-1', subjectType: 'user', subjectId: 'other-user' },
    ]);
    const readable = await service.isDocumentReadable('user-1', 'doc-1');
    expect(readable).toBe(false);
  });

  it('rejects non-granted subjects once ACL rows exist (deny-by-default)', async () => {
    mockPrisma.documentAcl.findMany.mockResolvedValue([
      { documentId: 'doc-1', subjectType: 'user', subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { documentId: 'doc-1', subjectType: 'role', subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    ]);
    mockPrisma.userRole.findMany.mockResolvedValue([
      { roleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    ]);
    mockPrisma.userOrg.findMany.mockResolvedValue([]);

    const readable = await service.isDocumentReadable(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'doc-1',
    );
    expect(readable).toBe(false);
  });

  it('allows a user/role/org subject explicitly listed in the ACL', async () => {
    const userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const roleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mockPrisma.documentAcl.findMany.mockResolvedValue([
      { documentId: 'doc-1', subjectType: 'role', subjectId: roleId },
    ]);
    mockPrisma.userRole.findMany.mockResolvedValue([{ roleId }]);

    const readable = await service.isDocumentReadable(userId, 'doc-1');
    expect(readable).toBe(true);
  });

  it('always allows the kb admin even when ACL denies the subject', async () => {
    mockPrisma.documentAcl.findMany.mockResolvedValue([
      { documentId: 'doc-1', subjectType: 'user', subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ]);
    mockPrisma.kbAdmin.findMany.mockResolvedValue([{ kbId: 'kb-1' }]);

    const readable = await service.isDocumentReadable('user-1', 'doc-1');
    expect(readable).toBe(true);
  });

  it('returns false for a missing document', async () => {
    mockPrisma.document.findUnique.mockResolvedValue(null);
    const readable = await service.isDocumentReadable('user-1', 'missing');
    expect(readable).toBe(false);
  });
});

describe('DocumentAclService mutation helpers', () => {
  let service: DocumentAclService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DocumentAclService(permissionService as any);
  });

  it('replaceAll clears existing rows then inserts the new set', async () => {
    mockPrisma.documentAcl.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.documentAcl.create.mockImplementation(async (args: any) => ({
      id: 'new-acl',
      ...args.data,
    }));
    mockPrisma.documentAcl.findMany.mockResolvedValue([]);

    await service.replaceAll('doc-1', [
      {
        subjectType: 'user',
        subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    ]);

    expect(mockPrisma.documentAcl.deleteMany).toHaveBeenCalledWith({
      where: { documentId: 'doc-1' },
    });
    expect(mockPrisma.documentAcl.create).toHaveBeenCalledTimes(1);
  });

  it('add skips duplicates for the same subject', async () => {
    mockPrisma.documentAcl.findFirst.mockResolvedValue({
      id: 'existing',
      documentId: 'doc-1',
    });
    const row = await service.add('doc-1', {
      subjectType: 'user',
      subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(row.id).toBe('existing');
    expect(mockPrisma.documentAcl.create).not.toHaveBeenCalled();
  });

  it('rejects invalid subjectType / subjectId', async () => {
    await expect(
      service.add('doc-1', { subjectType: 'group', subjectId: 'x' }),
    ).rejects.toThrow(/subjectType/);
    await expect(
      service.add('doc-1', {
        subjectType: 'user',
        subjectId: 'not-a-uuid',
      }),
    ).rejects.toThrow(/subjectId/);
  });
});

describe('DocumentAclService.canManageAcl', () => {
  let service: DocumentAclService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DocumentAclService(permissionService as any);
    mockPrisma.document.findUnique.mockResolvedValue({
      id: 'doc-1',
      kbId: 'kb-1',
      kb: { ownerUserId: 'owner-1', status: 'active' },
    });
    mockPrisma.kbAdmin.findFirst.mockResolvedValue(null);
    permissionService.isSystemAdmin.mockResolvedValue(false);
  });

  it('grants system admin', async () => {
    permissionService.isSystemAdmin.mockResolvedValue(true);
    expect(await service.canManageAcl('root', 'doc-1')).toBe(true);
  });

  it('grants kb owner and kb admin, rejects others', async () => {
    expect(await service.canManageAcl('owner-1', 'doc-1')).toBe(true);
    mockPrisma.kbAdmin.findFirst.mockResolvedValue({ kbId: 'kb-1' });
    expect(await service.canManageAcl('admin-1', 'doc-1')).toBe(true);
    mockPrisma.kbAdmin.findFirst.mockResolvedValue(null);
    expect(await service.canManageAcl('stranger', 'doc-1')).toBe(false);
  });
});
