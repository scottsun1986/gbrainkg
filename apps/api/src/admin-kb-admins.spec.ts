import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';

const caller = '11111111-1111-4111-8111-111111111111';
const assigned = '22222222-2222-4222-8222-222222222222';
const mockPrisma: any = {
  user: { findMany: jest.fn() },
  knowledgeBase: { create: jest.fn(), findUnique: jest.fn() },
  kbAdmin: { createMany: jest.fn(), deleteMany: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(0),
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn((fn: any) => fn(mockPrisma)),
};
jest.mock('./prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('knowledge-base administrator assignment', () => {
  const permissions: any = {
    isSystemAdmin: jest.fn(), hasPermission: jest.fn(), canManageIndustryKb: jest.fn(),
  };
  let controller: AdminController;
  beforeEach(() => {
    jest.clearAllMocks();
    permissions.isSystemAdmin.mockResolvedValue(false);
    permissions.hasPermission.mockResolvedValue(true);
    permissions.canManageIndustryKb.mockResolvedValue(true);
    mockPrisma.user.findMany.mockResolvedValue([{ id: assigned }]);
    mockPrisma.knowledgeBase.create.mockResolvedValue({ id: 'kb', _count: { documents: 0 } });
    mockPrisma.knowledgeBase.findUnique.mockResolvedValue({ id: 'kb', type: 'industry', ownerUserId: caller, status: 'active' });
    controller = new AdminController(permissions, { userIdFromRequest: async () => caller } as any, {} as any, {} as any, {} as any);
    (controller as any).scheduleAccessReconciliation = jest.fn().mockResolvedValue(undefined);
  });

  it('creates the industry library with exactly its selected administrators in one nested write', async () => {
    await controller.createKnowledgeBase({}, { name: 'industry', type: 'industry', adminUserIds: [assigned, assigned] });
    expect(mockPrisma.knowledgeBase.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ownerUserId: caller, admins: { create: [{ userId: assigned }] } }),
      include: { admins: true, _count: { select: { documents: true } } },
    }));
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({ where: { id: { in: [assigned] }, status: 'active' }, select: { id: true } });
    expect(mockPrisma.kbAdmin.createMany).not.toHaveBeenCalled();
  });

  it('retains the default caller administrator for older clients', async () => {
    await controller.createKnowledgeBase({}, { name: 'industry', type: 'industry' });
    expect(mockPrisma.knowledgeBase.create.mock.calls[0][0].data.admins).toEqual({ create: [{ userId: caller }] });
  });

  it.each([{ adminUserIds: [] }, { adminUserIds: ['invalid'] }])('rejects invalid administrators before creating any library: %j', async ({ adminUserIds }) => {
    await expect(controller.createKnowledgeBase({}, { name: 'industry', type: 'industry', adminUserIds })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.knowledgeBase.create).not.toHaveBeenCalled();
  });

  it('rejects disabled or missing administrators before creating any library', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    await expect(controller.createKnowledgeBase({}, { name: 'industry', type: 'industry', adminUserIds: [assigned] })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.knowledgeBase.create).not.toHaveBeenCalled();
  });

  it('inserts replacement administrators before removing the assigning administrator', async () => {
    await controller.updateKbAdmins({}, 'kb', { userIds: [assigned] });
    expect(mockPrisma.kbAdmin.createMany).toHaveBeenCalledWith({ data: [{ kbId: 'kb', userId: assigned }], skipDuplicates: true });
    expect(mockPrisma.kbAdmin.deleteMany).toHaveBeenCalledWith({ where: { kbId: 'kb', userId: { notIn: [assigned] } } });
    expect(mockPrisma.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(mockPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mockPrisma.kbAdmin.createMany.mock.invocationCallOrder[0]);
    expect(mockPrisma.kbAdmin.createMany.mock.invocationCallOrder[0]).toBeLessThan(mockPrisma.kbAdmin.deleteMany.mock.invocationCallOrder[0]);
  });

  it('does not read candidate users or write admins without resource management permission', async () => {
    permissions.canManageIndustryKb.mockResolvedValue(false);
    await expect(controller.updateKbAdmins({}, 'kb', { userIds: [assigned] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.kbAdmin.createMany).not.toHaveBeenCalled();
  });
});
