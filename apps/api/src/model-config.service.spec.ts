import { ModelConfigService } from './model-config.service';

const provider = {
  id: 'provider-1', name: 'compatible', baseUrl: 'https://model.invalid/v1',
  apiKeyEncrypted: '', defaultParams: {}, enabled: true,
};
const modelConfig = {
  id: 'model-1', kind: 'llm', modelName: 'model-a', contextLen: 8192,
  dimensions: null, createdAt: new Date(0), provider,
};
const mockPrisma = {
  modelConfig: { findFirst: jest.fn() },
  modelProvider: { update: jest.fn() },
  $disconnect: jest.fn(),
};
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('ModelConfigService cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    provider.defaultParams = {};
    mockPrisma.modelConfig.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.kind === 'llm' ? modelConfig : null),
    );
  });

  it('deduplicates hot-path reads and supports an explicit admin refresh', async () => {
    const service = new ModelConfigService();
    await service.applyRuntimeConfig();
    const readsAfterFirstApply = mockPrisma.modelConfig.findFirst.mock.calls.length;
    await service.applyRuntimeConfig();
    expect(mockPrisma.modelConfig.findFirst).toHaveBeenCalledTimes(readsAfterFirstApply);
    await service.applyRuntimeConfig(true);
    expect(mockPrisma.modelConfig.findFirst.mock.calls.length).toBeGreaterThan(readsAfterFirstApply);
  });

  it('removes stale runtime routes when an administrator deletes configuration', async () => {
    const service = new ModelConfigService();
    await service.applyRuntimeConfig(true);
    expect(process.env.LLM_MODEL).toBe('model-a');
    mockPrisma.modelConfig.findFirst.mockResolvedValue(null);
    await service.applyRuntimeConfig(true);
    expect(process.env.LLM_MODEL).toBeUndefined();
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it('projects the administrator-selected GBrain recipe instead of a fixed vendor', async () => {
    provider.defaultParams = { gbrainRecipe: 'openai' };
    const service = new ModelConfigService();
    await service.applyRuntimeConfig(true);
    expect(process.env.GBRAIN_CHAT_MODEL).toBe('openai:model-a');
    expect(process.env.GBRAIN_CHAT_BASE_URL).toBe(provider.baseUrl);
  });
});
