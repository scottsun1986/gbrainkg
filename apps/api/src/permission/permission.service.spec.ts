import { Test, TestingModule } from "@nestjs/testing";
import { PermissionService } from "./permission.service";

// Mock PrismaClient
const mockPrisma = {
  knowledgeBase: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
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
    expect(mockPrisma.industryGrant.deleteMany).toHaveBeenCalledWith({
      where: { subjectId: "user-1", kbId: "kb-industry-1" },
    });
  });
});
