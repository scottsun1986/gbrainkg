import { AdminController } from './admin.controller';
import { BadRequestException } from '@nestjs/common';

const mockTx = {
  modelConfig: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'model-1', ...data })),
  },
};
const mockPrisma = {
  modelProvider: {
    findUnique: jest.fn(),
  },
  modelConfig: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'model-1', ...data })),
  },
  $transaction: jest.fn((callback: any) => callback(mockTx)),
};
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('AdminController model creation recipe validation', () => {
  const modelConfigService = {
    applyRuntimeConfig: jest.fn().mockResolvedValue(undefined),
  };
  const auditService = {
    log: jest.fn().mockResolvedValue(undefined),
  };
  const authService = {
    adminUserIdFromRequest: jest.fn().mockResolvedValue('admin-id'),
  };

  const controller = new AdminController(
    {} as any,
    authService as any,
    {} as any,
    modelConfigService as any,
    auditService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows creating a rerank model under an OpenAI-compatible provider', async () => {
    mockPrisma.modelProvider.findUnique.mockResolvedValue({
      id: 'provider-siliconflow',
      name: '硅基流动',
      defaultParams: { note: '', gbrainRecipe: 'openai' },
    });

    const result = await controller.createModel(
      {},
      {
        providerId: 'provider-siliconflow',
        modelName: 'BAAI/bge-reranker-v2-m3',
        kind: 'rerank',
        isDefault: true,
      },
    );

    expect(result.model).toBeDefined();
    expect(result.model.kind).toBe('rerank');
    expect(result.model.modelName).toBe('BAAI/bge-reranker-v2-m3');
    expect(modelConfigService.applyRuntimeConfig).toHaveBeenCalledWith(true);
  });

  it('allows creating a rerank model under a llama-server-reranker provider', async () => {
    mockPrisma.modelProvider.findUnique.mockResolvedValue({
      id: 'provider-local',
      name: 'local-reranker',
      defaultParams: { gbrainRecipe: 'llama-server-reranker' },
    });

    const result = await controller.createModel(
      {},
      {
        providerId: 'provider-local',
        modelName: 'bge-reranker-large',
        kind: 'rerank',
      },
    );

    expect(result.model).toBeDefined();
    expect(result.model.kind).toBe('rerank');
  });

  it('rejects unsupported recipe for rerank', async () => {
    mockPrisma.modelProvider.findUnique.mockResolvedValue({
      id: 'provider-bad',
      name: 'bad-provider',
      defaultParams: { gbrainRecipe: 'unsupported-proto' },
    });

    await expect(
      controller.createModel(
        {},
        {
          providerId: 'provider-bad',
          modelName: 'some-model',
          kind: 'rerank',
        },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
