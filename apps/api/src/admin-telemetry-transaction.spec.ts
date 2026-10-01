import { AdminController } from './admin.controller';

let transactionOpen = false;
const collection = () => ({ findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) });
const mockPrisma: any = {
  user: collection(),
  orgNode: collection(),
  knowledgeBase: collection(),
  role: collection(),
  industryGrant: collection(),
  modelProvider: collection(),
  modelConfig: collection(),
  compileJob: collection(),
  document: collection(),
  auditLog: collection(),
  $executeRaw: jest.fn().mockResolvedValue(0),
  $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) => {
    transactionOpen = true;
    try {
      return await callback(mockPrisma);
    } finally {
      transactionOpen = false;
    }
  }),
};
jest.mock('./prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('admin audit telemetry transaction boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transactionOpen = false;
  });

  it('finishes the inventory transaction before running slow telemetry', async () => {
    const dream = { health: 'healthy' };
    const compiler = {
      getDreamTelemetry: jest.fn(async () => {
        expect(transactionOpen).toBe(false);
        return dream;
      }),
    };
    const controller = new AdminController(
      {
        getCapabilities: jest.fn().mockResolvedValue(['*']),
        isSystemAdmin: jest.fn().mockResolvedValue(true),
        getManagedOrgIds: jest.fn().mockResolvedValue(new Set()),
        getVisibleKnowledgeBases: jest.fn().mockResolvedValue([]),
        canManageKnowledgeBases: jest.fn().mockResolvedValue(new Map()),
      } as any,
      { userIdFromRequest: jest.fn().mockResolvedValue('admin') } as any,
      compiler as any,
      {} as any,
      {} as any,
    );
    const status = { health: 'healthy' };
    jest.spyOn(controller as any, 'getSystemStatusTelemetryData').mockImplementation(async () => {
      expect(transactionOpen).toBe(false);
      return status;
    });

    const result = await controller.getAllData({}, '1', '20', '1', '1');

    expect(result.dream).toBe(dream);
    expect(result.systemStatus).toBe(status);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(compiler.getDreamTelemetry).toHaveBeenCalledTimes(1);
  });
});
