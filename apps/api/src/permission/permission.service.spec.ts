import { Test, TestingModule } from "@nestjs/testing";
import { PermissionService } from "./permission.service";
import { BASE_USER_PERMISSIONS, DEFAULT_ROLES } from './permissions';

// Mock PrismaClient
const mockPrisma: any = {
  knowledgeBase: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  role: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn(), update: jest.fn() },
  user: { findMany: jest.fn(), findFirst: jest.fn() },
  userOrg: {
    findMany: jest.fn(),
  },
  orgNode: {
    findMany: jest.fn(),
  },
  userRole: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  orgAdmin: {
    findMany: jest.fn(),
  },
  kbAdmin: {
    findMany: jest.fn(),
  },
  industryGrant: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },

  $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn(mockPrisma as any)),
};

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
  };
});

describe("PermissionService", () => {
  let service: PermissionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PermissionService],
    }).compile();

    service = module.get<PermissionService>(PermissionService);
    jest.clearAllMocks();
    mockPrisma.orgNode.findMany.mockResolvedValue([]);
    mockPrisma.userRole.findFirst.mockResolvedValue(null);
    mockPrisma.userRole.findMany.mockResolvedValue([]);
    mockPrisma.orgAdmin.findMany.mockResolvedValue([]);
    mockPrisma.kbAdmin.findMany.mockResolvedValue([]);
  });

  it('does not rewrite unchanged defaults or converge a valid non-builtin role on startup', async () => {
    mockPrisma.role.findUnique.mockImplementation(async ({ where }: any) =>
      DEFAULT_ROLES.find((role) => where.code ? ('code' in role && role.code === where.code) : role.name === where.name),
    );
    mockPrisma.role.findMany.mockResolvedValue([
      { id: 'custom', name: '自定义角色', builtin: false, permissions: [...BASE_USER_PERMISSIONS] },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin' });
    mockPrisma.knowledgeBase.findFirst.mockResolvedValue(null);
    await service.onModuleInit();
    expect(mockPrisma.role.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.role.update).not.toHaveBeenCalled();
    expect(mockPrisma.knowledgeBase.updateMany).not.toHaveBeenCalled();
  });

  it('converges a non-builtin role carrying a wildcard or an unknown permission, generically', async () => {
    mockPrisma.role.findUnique.mockImplementation(async ({ where }: any) =>
      DEFAULT_ROLES.find((role) => where.code ? ('code' in role && role.code === where.code) : role.name === where.name),
    );
    mockPrisma.role.findMany.mockResolvedValue([
      { id: 'wildcard', name: '遗留角色', builtin: false, permissions: ['*'] },
      { id: 'stale', name: '过期角色', builtin: false, permissions: ['chat.use', 'old.permission'] },
      { id: 'valid', name: '有效角色', builtin: false, permissions: ['chat.use', 'kb.read'] },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin' });
    mockPrisma.knowledgeBase.findFirst.mockResolvedValue(null);
    await service.onModuleInit();
    expect(mockPrisma.role.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.role.update).toHaveBeenCalledWith({
      where: { id: 'wildcard' },
      data: { permissions: [...BASE_USER_PERMISSIONS] },
    });
    expect(mockPrisma.role.update).toHaveBeenCalledWith({
      where: { id: 'stale' },
      data: { permissions: [...BASE_USER_PERMISSIONS] },
    });
  });

  it('repairs changed defaults rather than suppressing real authorization changes', async () => {
    mockPrisma.role.findUnique.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    await service.onModuleInit();
    expect(mockPrisma.role.upsert).toHaveBeenCalledTimes(DEFAULT_ROLES.length);
  });

  it("keeps visibility helper queries on the supplied transaction", async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      userOrg: { findMany: jest.fn().mockResolvedValue([]) },
      orgNode: { findMany: jest.fn().mockResolvedValue([]) },
      userRole: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      knowledgeBase: { findMany: jest.fn().mockResolvedValue([]) },
      industryGrant: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // The root client cannot lease another connection while this transaction owns it.
    mockPrisma.$executeRaw = jest.fn();
    mockPrisma.$transaction.mockImplementationOnce(async (fn: any) => fn(tx));
    try {
      expect(await service.getVisibleKnowledgeBases('user-1')).toEqual([]);
      expect(tx.userOrg.findMany).toHaveBeenCalled();
      expect(tx.userRole.findFirst).toHaveBeenCalled();
      expect(mockPrisma.userOrg.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.userRole.findFirst).not.toHaveBeenCalled();
    } finally { delete mockPrisma.$executeRaw; }
  });

  it("should calculate visible knowledge bases correctly", async () => {
    // 1. Mock 直接管理的库
    mockPrisma.knowledgeBase.findMany.mockResolvedValueOnce([]);

    // 2. Mock 个人库
    mockPrisma.knowledgeBase.findMany.mockResolvedValueOnce([
      { id: "kb-personal-1" },
    ]);

    // 3. Mock 组织继承
    mockPrisma.userOrg.findMany.mockResolvedValueOnce([{ orgNodeId: "org-1" }]);
    mockPrisma.knowledgeBase.findMany.mockResolvedValueOnce([
      { id: "kb-org-1" },
    ]);

    // 3. Mock 行业库授权
    mockPrisma.industryGrant.findMany.mockResolvedValueOnce([
      { kbId: "kb-industry-1" },
    ]);

    const visibleKbs = await service.getVisibleKnowledgeBases("user-1");

    expect(visibleKbs).toContain("kb-personal-1");
    expect(visibleKbs).toContain("kb-org-1");
    expect(visibleKbs).toContain("kb-industry-1");
    expect(visibleKbs.length).toBe(3);
  });

  it("does not expose descendant organization libraries to a parent employee", async () => {
    mockPrisma.userOrg.findMany.mockResolvedValue([{ orgNodeId: "org-rd" }]);
    mockPrisma.orgNode.findMany.mockResolvedValue([
      { id: "org-root", parentId: null },
      { id: "org-rd", parentId: "org-root" },
      { id: "org-dev", parentId: "org-rd" },
    ]);
    mockPrisma.knowledgeBase.findMany
      .mockResolvedValueOnce([]) // direct managed
      .mockResolvedValueOnce([]) // personal
      .mockResolvedValueOnce([{ id: "kb-rd" }]); // self + ancestors only
    mockPrisma.kbAdmin.findMany.mockResolvedValue([]);
    mockPrisma.industryGrant.findMany.mockResolvedValue([]);

    const visibleKbs = await service.getVisibleKnowledgeBases("user-rd");

    expect(visibleKbs).toContain("kb-rd");
    expect(visibleKbs).not.toContain("kb-dev");
  });

  it("resolves industry organization grants through the member organization and all ancestors", async () => {
    mockPrisma.userOrg.findMany.mockResolvedValue([{ orgNodeId: "org-dev" }]);
    mockPrisma.orgNode.findMany.mockResolvedValue([
      { id: "org-root", parentId: null },
      { id: "org-rd", parentId: "org-root" },
      { id: "org-dev", parentId: "org-rd" },
    ]);
    mockPrisma.knowledgeBase.findMany
      .mockResolvedValueOnce([]) // direct managed
      .mockResolvedValueOnce([]) // personal
      .mockResolvedValueOnce([]); // organization
    mockPrisma.kbAdmin.findMany.mockResolvedValue([]);
    mockPrisma.industryGrant.findMany.mockResolvedValue([
      { kbId: "kb-industry-1" },
    ]);

    const visibleKbs = await service.getVisibleKnowledgeBases("user-dev");
    const grantQuery = mockPrisma.industryGrant.findMany.mock.calls[0][0];
    const grantSubjects = grantQuery.where.AND[0].OR;

    expect(visibleKbs).toContain("kb-industry-1");
    expect(grantSubjects).toEqual(
      expect.arrayContaining([
        { subjectType: "user", subjectId: "user-dev" },
        { subjectType: "org", subjectId: "org-dev" },
        { subjectType: "org", subjectId: "org-rd" },
        { subjectType: "org", subjectId: "org-root" },
      ]),
    );
  });

  it("derives organization administration scope from the organization administrator role", async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([
      { role: { permissions: ["org.user.manage"] } },
    ]);
    mockPrisma.userOrg.findMany.mockResolvedValue([{ orgNodeId: "org-rd" }]);
    mockPrisma.orgNode.findMany.mockResolvedValue([
      { id: "org-root", parentId: null },
      { id: "org-rd", parentId: "org-root" },
      { id: "org-dev", parentId: "org-rd" },
    ]);

    const managed = await service.getManagedOrgIds("user-rd");

    expect(managed).toEqual(new Set(["org-rd", "org-dev"]));
  });

  it("keeps industry module access from the industry administrator role", async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([
      {
        role: {
          permissions: [
            "chat.use",
            "kb.read",
            "reader.read",
            "kb.industry.read",
            "kb.industry.grant",
          ],
        },
      },
    ]);
    const capabilities = await service.getCapabilities("user-industry-admin");
    expect(capabilities).toEqual(
      expect.arrayContaining(["kb.industry.read", "kb.industry.grant"]),
    );
  });

  it("does not infer industry module access from a KB administrator relationship", async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([
      { role: { permissions: ["chat.use", "kb.read", "reader.read"] } },
    ]);
    const capabilities = await service.getCapabilities("user-kb-admin");
    expect(capabilities).not.toContain("kb.industry.read");
  });

  it("does not let an industry KB owner grant readers after administration is transferred", async () => {
    mockPrisma.knowledgeBase.findFirst.mockResolvedValue(null);
    await expect(
      service.canGrantIndustryKb("owner-only", "kb-1"),
    ).resolves.toBe(false);
    expect(mockPrisma.knowledgeBase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          admins: { some: { userId: "owner-only" } },
        }),
      }),
    );
  });

  it("does not infer organization management from an OrgAdmin row without the role", async () => {
    mockPrisma.userRole.findMany.mockResolvedValue([
      { role: { permissions: ["chat.use", "kb.read", "reader.read"] } },
    ]);
    mockPrisma.orgAdmin.findMany.mockResolvedValue([{ orgNodeId: "org-rd" }]);
    const managed = await service.getManagedOrgIds("user-without-org-role");
    expect(managed).toEqual(new Set());
  });

  it("should revoke access and delete grants", async () => {
    await service.revokeAccess("user-1", "kb-industry-1");
    // Scoped to the user subject so a role/org grant whose subjectId happens to
    // equal this user's UUID is not deleted along with it.
    expect(mockPrisma.industryGrant.deleteMany).toHaveBeenCalledWith({
      where: { subjectType: "user", subjectId: "user-1", kbId: "kb-industry-1" },
    });
  });
});
