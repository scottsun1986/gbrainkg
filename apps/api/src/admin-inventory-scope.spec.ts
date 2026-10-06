import { AdminController } from './admin.controller';

const mockPrisma: any = {
  user: { findMany: jest.fn() },
  orgNode: { findMany: jest.fn().mockResolvedValue([]) },
  knowledgeBase: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  role: { findMany: jest.fn().mockResolvedValue([]) },
  industryGrant: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  modelProvider: { findMany: jest.fn().mockResolvedValue([]) },
  modelConfig: { findMany: jest.fn().mockResolvedValue([]) },
  compileJob: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  document: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  auditLog: { findMany: jest.fn().mockResolvedValue([]) },
  $executeRaw: jest.fn().mockResolvedValue(0),
  $transaction: jest.fn((callback: any) => callback(mockPrisma)),
};
jest.mock('./prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('elevated admin inventory scope', () => {
  const permissions: any = {
    getCapabilities: jest.fn().mockResolvedValue(['org.read', 'org.user.read']),
    isSystemAdmin: jest.fn().mockResolvedValue(false),
    getManagedOrgIds: jest.fn().mockResolvedValue(new Set(['managed', 'child'])),
    getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['readable']),
    canManageKnowledgeBases: jest.fn().mockResolvedValue(new Map()),
  };
  let controller: AdminController;

  beforeEach(() => {
    jest.clearAllMocks();
    permissions.isSystemAdmin.mockResolvedValue(false);
    permissions.getCapabilities.mockResolvedValue(['org.read', 'org.user.read']);
    mockPrisma.knowledgeBase.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    controller = new AdminController(permissions, { userIdFromRequest: async () => 'caller' } as any, {} as any, {} as any, {} as any);
  });

  it('limits after user scope so older unrelated users cannot hide a managed member', async () => {
    const outside = { id: 'outside', roles: [], orgs: [{ orgNodeId: 'sibling' }] };
    const member = { id: 'member', roles: [], orgs: [{ orgNodeId: 'child' }] };
    mockPrisma.user.findMany.mockImplementation(async ({ where, take }: any) => {
      const allowed = where?.OR?.find((item: any) => item.orgs)?.orgs.some.orgNodeId.in;
      return [outside, member].filter((user) => !where || user.id === where.OR[0].id || allowed?.includes(user.orgs[0].orgNodeId)).slice(0, take);
    });
    const result = await controller.getAllData({}, undefined, undefined, undefined, undefined, '1');
    expect(result.users.map((user: any) => user.id)).toEqual(['member']);
    expect(mockPrisma.orgNode.findMany.mock.calls[0][0].where.id.in).toEqual(['managed', 'child']);
  });

  it('keeps industry-linked organizations and shares KB scope with nested includes', async () => {
    mockPrisma.knowledgeBase.findMany.mockResolvedValueOnce([
      { id: 'owned-industry', type: 'industry', ownerUserId: 'caller', orgNodeId: 'industry-org', admins: [], _count: { documents: 0 } },
    ]);
    await controller.getAllData({});
    const orgQuery = mockPrisma.orgNode.findMany.mock.calls[0][0];
    expect(orgQuery.where.id.in).toContain('industry-org');
    expect(orgQuery.include.kbs.where).toEqual(mockPrisma.knowledgeBase.findMany.mock.calls[0][0].where);
    expect(mockPrisma.industryGrant.findMany.mock.calls[0][0].where).toEqual({ kbId: { in: ['owned-industry'] } });
  });

  it('filters other users personal KBs even for a system administrator', async () => {
    permissions.isSystemAdmin.mockResolvedValue(true);
    await controller.getAllData({});
    expect(mockPrisma.knowledgeBase.findMany.mock.calls[0][0].where.OR)
      .toEqual([{ type: { not: 'personal' } }, { ownerUserId: 'caller' }]);
  });

  it('returns only the two assignable roles to an organization administrator without role.read', async () => {
    // 组织管理员（org.user.manage，但无 role.read）：新增人员弹窗必须能选到
    // 「组织管理员/普通用户」，且不得看到其它角色。
    permissions.getCapabilities.mockResolvedValue(['org.read', 'org.user.manage']);
    mockPrisma.role.findMany.mockResolvedValue([
      { id: 'r-org', name: '组织管理员', permissions: [], _count: { users: 2 } },
      { id: 'r-basic', name: '普通用户', permissions: [], _count: { users: 9 } },
      { id: 'r-ind', name: '行业库管理员', permissions: [], _count: { users: 1 } },
    ]);
    const result = await controller.getAllData({});
    expect(result.roles.map((role: any) => role.name).sort()).toEqual(['普通用户', '组织管理员'].sort());
  });
});
