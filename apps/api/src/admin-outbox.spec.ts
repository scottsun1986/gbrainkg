import { AdminController } from './admin.controller';

const mockTx = {
  user: { update: jest.fn().mockResolvedValue({ id: 'user-1' }) },
  industryGrant: { delete: jest.fn() },
  brainChangeEvent: { create: jest.fn() },
};
const mockPrisma = {
  industryGrant: { findUnique: jest.fn().mockResolvedValue({ id: 'grant-1', kbId: 'kb-1' }) },
  $transaction: jest.fn((callback: any) => callback(mockTx)),
};
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('admin outbox transaction boundaries', () => {
  const dispatchPending = jest.fn();
  const queueAccessReconciliation = jest.fn().mockResolvedValue(undefined);
  const controller = new AdminController(
    { canManageUser: async () => true, canGrantIndustryKb: async () => true } as any,
    { userIdFromRequest: async () => 'admin' } as any,
    { queueAccessReconciliation } as any, {} as any, { dispatchPending } as any,
  );
  beforeEach(() => { jest.clearAllMocks(); mockTx.brainChangeEvent.create.mockReset(); });

  it.each(['disableUser', 'deleteGrant'] as const)('%s writes event inside transaction before dispatch', async method => {
    await controller[method]({}, method === 'disableUser' ? 'user-1' : 'grant-1');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.brainChangeEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'perm_revoke', status: 'pending' }) }));
    expect(dispatchPending).toHaveBeenCalledTimes(1);
    expect(mockTx.brainChangeEvent.create.mock.invocationCallOrder[0]).toBeLessThan(dispatchPending.mock.invocationCallOrder[0]);
  });
  it.each(['disableUser', 'deleteGrant'] as const)('%s does not dispatch an event from a rejected transaction', async method => {
    mockTx.brainChangeEvent.create.mockRejectedValue(new Error('event write failure'));
    await expect(controller[method]({}, 'fixture')).rejects.toThrow('event write failure');
    expect(dispatchPending).not.toHaveBeenCalled();
    expect(queueAccessReconciliation).not.toHaveBeenCalled();
  });
});
