import { AdminController } from './admin.controller';

const secretUser = {
  id: 'user-1', username: 'reader', displayName: 'Reader', email: 'r@example.test',
  mustChangePassword: false, status: 'active', source: 'manual',
  mfaEnabled: true, mfaEnabledAt: new Date(), createdAt: new Date(),
  roles: [], orgs: [{ orgNodeId: 'org-1', orgNode: { id: 'org-1' } }],
  passwordHash: 'hashed-secret', mfaSecret: 'totp-secret', oidcSub: 'oidc-secret',
  futureAuthSecret: 'future-secret',
};
const collection = () => ({ findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) });
const mockPrisma: any = {
  user: { ...collection(), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  orgNode: collection(), knowledgeBase: collection(), role: { ...collection(), findUnique: jest.fn().mockResolvedValue(null) },
  industryGrant: collection(), modelProvider: collection(), modelConfig: collection(),
  compileJob: collection(), document: collection(), auditLog: collection(),
  brainChangeEvent: { create: jest.fn().mockResolvedValue({}) },
  userOrg: { deleteMany: jest.fn(), createMany: jest.fn() },
  userRole: { deleteMany: jest.fn(), createMany: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(0),
  $transaction: jest.fn((callback: (tx: any) => Promise<any>) => callback(mockPrisma)),
};
jest.mock('./prisma', () => ({ getPrismaClient: () => mockPrisma }));

const forbiddenFields = ['passwordHash', 'mfaSecret', 'oidcSub', 'futureAuthSecret'];
function expectSafe(user: any) {
  expect(user).toMatchObject({ id: secretUser.id, username: secretUser.username, mfaEnabled: true });
  for (const field of forbiddenFields) expect(user).not.toHaveProperty(field);
}

describe('admin user responses', () => {
  let controller: AdminController;
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue(secretUser);
    mockPrisma.user.update.mockResolvedValue(secretUser);
    mockPrisma.orgNode.findMany.mockResolvedValue([{ id: 'org-1' }]);
    controller = new AdminController(
      {
        isSystemAdmin: jest.fn().mockResolvedValue(true),
        canManageUser: jest.fn().mockResolvedValue(true),
        getCapabilities: jest.fn().mockResolvedValue(['*']),
        getManagedOrgIds: jest.fn().mockResolvedValue(new Set(['org-1'])),
        getVisibleKnowledgeBases: jest.fn().mockResolvedValue([]),
        canManageKnowledgeBases: jest.fn().mockResolvedValue(new Map()),
      } as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('operator'), hashPassword: jest.fn().mockReturnValue('hash'), invalidateUserStatus: jest.fn() } as any,
      { queueAccessReconciliation: jest.fn().mockResolvedValue(undefined), ensureUserBrainRepo: jest.fn().mockResolvedValue(undefined), invalidateUserScope: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { kickDispatch: jest.fn() } as any,
    );
  });

  it('GET /admin/data selects only safe User fields and returns no auth secrets', async () => {
    mockPrisma.user.findMany.mockResolvedValue([secretUser]);
    const data = await controller.getAllData({} as any, '1', '20', '1', '0');
    expect(mockPrisma.user.findMany.mock.calls[0][0].select).toBeDefined();
    expect(mockPrisma.user.findMany.mock.calls[0][0].select).not.toHaveProperty('passwordHash');
    expect(mockPrisma.user.findMany.mock.calls[0][0].select).not.toHaveProperty('mfaSecret');
    expect(mockPrisma.user.findMany.mock.calls[0][0].select).not.toHaveProperty('oidcSub');
    expectSafe(data.users[0]);
  });

  it('POST /admin/users returns a safe user DTO', async () => {
    const result = await controller.createUser({}, { username: 'reader', displayName: 'Reader', orgIds: ['org-1'], password: 'safe-test-password' });
    expect(mockPrisma.user.create.mock.calls[0][0].select).toBeDefined();
    expectSafe(result.user);
  });

  it('PATCH /admin/users/:id returns a safe user DTO', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(secretUser);
    const result = await controller.updateUser({}, secretUser.id, { displayName: 'Reader 2' });
    expect(mockPrisma.user.findUnique.mock.calls.at(-1)?.[0].select).toBeDefined();
    expectSafe(result.user);
  });

  it('clears the stored seed so an administrator can unbind a lost authenticator', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      ...secretUser, mfaEnabled: true, mfaEnabledAt: new Date(), mfaSecret: 'enc:v1:abc',
    });
    mockPrisma.user.update.mockImplementation(async (args: any) => ({ ...secretUser, ...args.data }));

    await controller.updateUser({}, secretUser.id, { mfaEnabled: false });

    const data = mockPrisma.user.update.mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({ mfaEnabled: false, mfaSecret: null, mfaLastCounter: null, mfaEnabledAt: null });
  });

  it('never rewrites the secret when MFA is left enabled', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...secretUser, mfaEnabled: true, mfaEnabledAt: new Date() });
    mockPrisma.user.update.mockImplementation(async (args: any) => ({ ...secretUser, ...args.data }));

    await controller.updateUser({}, secretUser.id, { displayName: 'Renamed' });

    const data = mockPrisma.user.update.mock.calls.at(-1)?.[0].data;
    expect(data).not.toHaveProperty('mfaSecret');
    expect(data).not.toHaveProperty('mfaEnabled');
  });


  it('DELETE /admin/users/:id returns a safe user DTO', async () => {
    const result = await controller.disableUser({}, secretUser.id);
    expect(mockPrisma.user.update.mock.calls[0][0].select).toBeDefined();
    expectSafe(result.user);
  });
});

describe('admin data permission matrix (kb.industry.read only)', () => {
  const operator = {
    ...secretUser,
    id: 'operator', username: 'industry-reader', displayName: 'Industry Reader',
    orgs: [{ orgNodeId: 'org-unrelated', orgNode: { id: 'org-unrelated' } }],
  };
  const stranger = {
    ...secretUser, id: 'user-2', username: 'stranger', displayName: 'Stranger',
    orgs: [{ orgNodeId: 'org-unrelated', orgNode: { id: 'org-unrelated' } }],
  };

  function buildIndustryOnlyController() {
    return new AdminController(
      {
        isSystemAdmin: jest.fn().mockResolvedValue(false),
        canManageUser: jest.fn().mockResolvedValue(false),
        getCapabilities: jest.fn().mockResolvedValue(['kb.industry.read']),
        getManagedOrgIds: jest.fn().mockResolvedValue(new Set()),
        getVisibleKnowledgeBases: jest.fn().mockResolvedValue([]),
        canManageKnowledgeBases: jest.fn().mockResolvedValue(new Map()),
      } as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('operator'), hashPassword: jest.fn().mockReturnValue('hash'), invalidateUserStatus: jest.fn() } as any,
      { queueAccessReconciliation: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { kickDispatch: jest.fn() } as any,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Not a direct industry KB admin: capability kb.industry.read only.
    mockPrisma.knowledgeBase.count.mockResolvedValue(0);
    mockPrisma.orgNode.findMany.mockResolvedValue([
      { id: 'org-industry', path: 'a', sort: 1 },
      { id: 'org-unrelated', path: 'b', sort: 1 },
    ]);
    mockPrisma.knowledgeBase.findMany.mockResolvedValue([
      {
        id: 'kb-ind', type: 'industry', status: 'active', ownerUserId: 'operator',
        orgNodeId: 'org-industry', admins: [], _count: { documents: 0 },
      },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([operator, stranger]);
    mockPrisma.role.findMany.mockResolvedValue([
      { id: 'role-1', name: 'Reader', permissions: [], _count: { users: 1 } },
    ]);
  });

  it('returns the full org tree read-only to industry roles', async () => {
    const data = await buildIndustryOnlyController().getAllData({} as any, '1', '20', '1', '0');
    expect(data.orgs.map((org: any) => org.id).sort()).toEqual(['org-industry', 'org-unrelated']);
    expect(data.orgs.every((org: any) => !org.canManage && !org.canCreateChild && !org.canSetAdmin)).toBe(true);
  });

  it('exposes the full user tree read-only to industry roles', async () => {
    const data = await buildIndustryOnlyController().getAllData({} as any, '1', '20', '1', '0');
    expect(data.users.map((user: any) => user.id).sort()).toEqual(['operator', 'user-2']);
    expect(data.users.every((user: any) => user.canManage === false)).toBe(true);
  });

  it('returns an empty role list without role.read', async () => {
    const data = await buildIndustryOnlyController().getAllData({} as any, '1', '20', '1', '0');
    expect(data.roles).toEqual([]);
  });

  it('still exposes the managed industry KB so the industry console keeps working', async () => {
    const data = await buildIndustryOnlyController().getAllData({} as any, '1', '20', '1', '0');
    expect(data.managedIndustryKbs.some((kb: any) => kb.id === 'kb-ind')).toBe(true);
  });
});
