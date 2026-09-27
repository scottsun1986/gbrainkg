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
      { dispatchPending: jest.fn().mockResolvedValue(undefined) } as any,
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
    const result = await controller.createUser({}, { username: 'reader', displayName: 'Reader', orgIds: ['org-1'] });
    expect(mockPrisma.user.create.mock.calls[0][0].select).toBeDefined();
    expectSafe(result.user);
  });

  it('PATCH /admin/users/:id returns a safe user DTO', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(secretUser);
    const result = await controller.updateUser({}, secretUser.id, { displayName: 'Reader 2' });
    expect(mockPrisma.user.findUnique.mock.calls.at(-1)?.[0].select).toBeDefined();
    expectSafe(result.user);
  });

  it('DELETE /admin/users/:id returns a safe user DTO', async () => {
    const result = await controller.disableUser({}, secretUser.id);
    expect(mockPrisma.user.update.mock.calls[0][0].select).toBeDefined();
    expectSafe(result.user);
  });
});
