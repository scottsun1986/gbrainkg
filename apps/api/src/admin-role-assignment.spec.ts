import { ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';

/**
 * 角色授予边界（业务强约束 3.5）：
 * - “行业库创建者”只能由超级管理员授予；
 * - 组织管理员（非系统管理员）只能授予“组织管理员/普通用户”；
 * - 受保护身份仍只能由系统管理员授予。
 *
 * 同时覆盖行业库授权候选目录接口的鉴权：只有系统管理员或持 kb.industry.grant
 * 的行业库管理员可拉取全量候选主体。
 */
const ORG_ADMIN = { id: 'r-org', name: '组织管理员', code: null, builtin: false, permissions: ['org.read'] };
const BASIC = { id: 'r-basic', name: '普通用户', code: null, builtin: false, permissions: ['chat.use'] };
const INDUSTRY_ADMIN = { id: 'r-ind-admin', name: '行业库管理员', code: null, builtin: false, permissions: ['kb.industry.grant'] };
const INDUSTRY_CREATOR = { id: 'r-ind-creator', name: '行业库创建者', code: null, builtin: false, permissions: ['kb.industry.create'] };
const SYSTEM_ADMIN = { id: 'r-sys', name: '系统管理员', code: 'system_admin', builtin: true, permissions: ['*'] };

const mockPrisma: any = {
  role: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  orgNode: { findMany: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(0),
  $transaction: jest.fn((fn: any) => fn(mockPrisma)),
};
jest.mock('./prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('admin role assignment boundary', () => {
  const permissions: any = {
    isSystemAdmin: jest.fn(),
    isSuperAdmin: jest.fn(),
    getCapabilities: jest.fn(),
  };
  let controller: AdminController;

  beforeEach(() => {
    jest.clearAllMocks();
    permissions.isSystemAdmin.mockResolvedValue(false);
    permissions.isSuperAdmin.mockResolvedValue(false);
    mockPrisma.role.findMany.mockResolvedValue([]);
    controller = new AdminController(
      permissions,
      { userIdFromRequest: async () => 'operator' } as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  const validate = (roleIds: string[]) =>
    (controller as any).validateAssignableRoles('operator', roleIds);

  it('lets an organization administrator assign the basic-user role', async () => {
    mockPrisma.role.findMany.mockResolvedValue([BASIC]);
    await expect(validate([BASIC.id])).resolves.toBeUndefined();
  });

  it('lets an organization administrator assign the organization-administrator role', async () => {
    mockPrisma.role.findMany.mockResolvedValue([ORG_ADMIN]);
    await expect(validate([ORG_ADMIN.id])).resolves.toBeUndefined();
  });

  it('refuses an organization administrator assigning the industry-library administrator role', async () => {
    mockPrisma.role.findMany.mockResolvedValue([INDUSTRY_ADMIN]);
    await expect(validate([INDUSTRY_ADMIN.id])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an organization administrator assigning the industry-library creator role', async () => {
    mockPrisma.role.findMany.mockResolvedValue([INDUSTRY_CREATOR]);
    await expect(validate([INDUSTRY_CREATOR.id])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a whole submission that mixes an allowed and a forbidden role', async () => {
    mockPrisma.role.findMany.mockResolvedValue([BASIC, INDUSTRY_CREATOR]);
    await expect(validate([BASIC.id, INDUSTRY_CREATOR.id])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a plain system administrator assigning the industry-library creator role', async () => {
    permissions.isSystemAdmin.mockResolvedValue(true);
    mockPrisma.role.findMany.mockResolvedValue([INDUSTRY_CREATOR]);
    await expect(validate([INDUSTRY_CREATOR.id])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super administrator assign the industry-library creator role', async () => {
    permissions.isSystemAdmin.mockResolvedValue(true);
    permissions.isSuperAdmin.mockResolvedValue(true);
    mockPrisma.role.findMany.mockResolvedValue([INDUSTRY_CREATOR]);
    await expect(validate([INDUSTRY_CREATOR.id])).resolves.toBeUndefined();
  });

  it('refuses an organization administrator assigning a protected role', async () => {
    mockPrisma.role.findMany.mockResolvedValue([SYSTEM_ADMIN]);
    await expect(validate([SYSTEM_ADMIN.id])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a system administrator assign a protected role', async () => {
    permissions.isSystemAdmin.mockResolvedValue(true);
    mockPrisma.role.findMany.mockResolvedValue([SYSTEM_ADMIN]);
    await expect(validate([SYSTEM_ADMIN.id])).resolves.toBeUndefined();
  });
});

describe('grant subject catalog access', () => {
  const permissions: any = {
    isSystemAdmin: jest.fn(),
    isSuperAdmin: jest.fn(),
    getCapabilities: jest.fn(),
  };
  let controller: AdminController;

  function buildController() {
    return new AdminController(
      permissions,
      { userIdFromRequest: async () => 'operator' } as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    permissions.isSystemAdmin.mockResolvedValue(false);
    permissions.isSuperAdmin.mockResolvedValue(false);
    permissions.getCapabilities.mockResolvedValue(['org.read']);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'u1', displayName: '张三', username: 'zhangsan', orgs: [{ orgNode: { id: 'o1', name: '研发中心', path: '/研发中心', parentId: null } }] },
      { id: 'u2', displayName: '李四', username: 'lisi', orgs: [] },
    ]);
    mockPrisma.role.findMany.mockResolvedValue([{ id: 'r1', name: '普通用户', _count: { users: 2 } }]);
    mockPrisma.orgNode.findMany.mockResolvedValue([{ id: 'o1', name: '研发中心', path: '/研发中心', parentId: null }]);
    controller = buildController();
  });

  it('refuses callers without an industry capability', async () => {
    await expect(controller.listIndustrySubjects({} as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the full active candidate catalog to an industry-library administrator', async () => {
    permissions.getCapabilities.mockResolvedValue(['kb.industry.grant']);
    const result = await controller.listIndustrySubjects({} as any);
    expect(result.users.map((u: any) => u.id)).toEqual(['u1', 'u2']);
    expect(result.users[0]).toMatchObject({ id: 'u1', orgIds: ['o1'] });
    expect(result.roles).toEqual([{ id: 'r1', name: '普通用户', users: 2 }]);
    expect(result.orgs).toEqual([{ id: 'o1', name: '研发中心', path: '/研发中心', parentId: null }]);
    // 候选人员只取未停用账户。
    expect(mockPrisma.user.findMany.mock.calls[0][0].where).toEqual({ status: 'active' });
  });

  it('lets an industry-library creator pick administrators', async () => {
    permissions.getCapabilities.mockResolvedValue(['kb.industry.create']);
    const result = await controller.listIndustrySubjects({} as any);
    expect(result.users).toHaveLength(2);
  });

  it('returns the catalog to a system administrator regardless of explicit capability', async () => {
    permissions.isSystemAdmin.mockResolvedValue(true);
    const result = await controller.listIndustrySubjects({} as any);
    expect(result.users).toHaveLength(2);
  });
});
