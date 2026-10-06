import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin.controller';

/**
 * `*` is the capability auth.guard.ts treats as "system administrator", so
 * granting it to any role outside the protected administrator identities makes
 * every holder a system administrator. The basic-user role is `builtin: false`
 * (permission/permissions.ts DEFAULT_ROLES), so a guard keyed on `builtin`
 * never covered it — the reported escalation.
 */
const BASIC_ROLE = {
  id: 'role-basic',
  name: '普通用户',
  code: 'basic_user',
  builtin: false,
  permissions: ['chat.use', 'kb.read'],
};
const ADMIN_ROLE = {
  id: 'role-admin',
  name: '系统管理员',
  code: 'system_admin',
  builtin: true,
  permissions: ['*'],
};

const mockPrisma: any = {
  role: {
    findUnique: jest.fn(),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(async ({ data }: any) => ({ id: 'role-new', ...data })),
    update: jest.fn(async ({ data }: any) => ({ ...BASIC_ROLE, ...data })),
  },
  brainChangeEvent: { create: jest.fn().mockResolvedValue({}) },
  $executeRaw: jest.fn().mockResolvedValue(0),
  $transaction: jest.fn((callback: (tx: any) => Promise<any>) => callback(mockPrisma)),
};
jest.mock('./prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('admin role permission boundary', () => {
  let controller: AdminController;
  const req = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.role.findFirst.mockResolvedValue(null);
    controller = new AdminController(
      {} as any,
      { adminUserIdFromRequest: jest.fn().mockResolvedValue('admin-1') } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (controller as any).scheduleAccessReconciliation = jest.fn().mockResolvedValue(undefined);
  });

  it('refuses to grant the wildcard to the basic-user role', async () => {
    mockPrisma.role.findUnique.mockResolvedValue(BASIC_ROLE);
    await expect(controller.updateRole(req, BASIC_ROLE.id, { permissions: ['*'] }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.role.update).not.toHaveBeenCalled();
  });

  it('still allows an ordinary permission change on the basic-user role', async () => {
    mockPrisma.role.findUnique.mockResolvedValue(BASIC_ROLE);
    await controller.updateRole(req, BASIC_ROLE.id, { permissions: ['chat.use'] });
    expect(mockPrisma.role.update).toHaveBeenCalled();
  });

  it('refuses to create a role that carries the wildcard', async () => {
    await expect(controller.createRole(req, { name: '自定义管理员', permissions: ['*'] }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.role.create).not.toHaveBeenCalled();
  });

  it('creates an ordinary role', async () => {
    await controller.createRole(req, { name: '只读用户', permissions: ['kb.read'] });
    expect(mockPrisma.role.create).toHaveBeenCalled();
  });

  it('does not block the protected administrator role from keeping its wildcard', async () => {
    mockPrisma.role.findUnique.mockResolvedValue(ADMIN_ROLE);
    await controller.updateRole(req, ADMIN_ROLE.id, { permissions: ['*'] });
    expect(mockPrisma.role.update).toHaveBeenCalled();
  });
});
