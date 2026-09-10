import { EmbeddingService } from './embedding.service';

describe('EmbeddingService', () => {
  const modelConfigService = {
    getDefault: jest.fn().mockResolvedValue({
      provider: { baseUrl: 'https://embed.example.com/v1', apiKey: 'k' },
      modelName: 'BAAI/bge-m3',
      dimensions: 4,
    }),
  } as any;

  let service: EmbeddingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EmbeddingService(modelConfigService);
  });

  it('parses OpenAI-compatible embeddings and preserves input order', async () => {
    const originalFetch = global.fetch;
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0, 0, 0, 1] },
          { index: 0, embedding: [1, 0, 0, 0] },
        ],
      }),
    });
    try {
      const result = await service.embed(['first', 'second']);
      expect(result[0]).toEqual([1, 0, 0, 0]);
      expect(result[1]).toEqual([0, 0, 0, 1]);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  it('drops vectors whose dimension does not match the configured model', async () => {
    const originalFetch = global.fetch;
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    });
    try {
      const result = await service.embed(['x']);
      expect(result[0]).toBeNull();
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  it('fails open when the provider errors', async () => {
    const originalFetch = global.fetch;
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
    try {
      await expect(service.embed(['a', 'b'])).resolves.toEqual([null, null]);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  it('returns null immediately when no embedding route is configured', async () => {
    const isolated = new EmbeddingService({ getDefault: jest.fn().mockResolvedValue(null) } as any);
    await expect(isolated.embedOne('x')).resolves.toBeNull();
  });
});
