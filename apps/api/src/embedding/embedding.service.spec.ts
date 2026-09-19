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

  it('serves repeated embeddings from client memory cache without network call', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ index: 0, embedding: [1, 2, 3, 4] }],
      }),
    });
    (global as any).fetch = fetchMock;
    try {
      const res1 = await service.embedOne('repeated query');
      expect(res1).toEqual([1, 2, 3, 4]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call must hit client memory cache
      const res2 = await service.embedOne('repeated query');
      expect(res2).toEqual([1, 2, 3, 4]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  it('deduplicates concurrent in-flight calls for the same text (singleflight)', async () => {
    const originalFetch = global.fetch;
    let inflightResolve: any;
    const fetchPromise = new Promise((resolve) => {
      inflightResolve = resolve;
    });
    const fetchMock = jest.fn().mockImplementation(() =>
      fetchPromise.then(() => ({
        ok: true,
        json: async () => ({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
        }),
      })),
    );
    (global as any).fetch = fetchMock;
    try {
      // Launch two concurrent calls for the exact same text before fetch finishes
      const p1 = service.embedOne('concurrent query');
      const p2 = service.embedOne('concurrent query');

      // Resolve the fetch
      inflightResolve();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(r2).toEqual([0.1, 0.2, 0.3, 0.4]);
      // Singleflight must ensure only 1 fetch call was made
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  it('does not reuse a cached vector after the embedding route changes', async () => {
    const originalFetch = global.fetch;
    const dynamicConfig = {
      getDefault: jest.fn()
        .mockResolvedValueOnce({
          provider: { baseUrl: 'https://a.example.com/v1', apiKey: 'a' },
          modelName: 'shared-name', dimensions: 4,
        })
        .mockResolvedValueOnce({
          provider: { baseUrl: 'https://b.example.com/v1', apiKey: 'b' },
          modelName: 'shared-name', dimensions: 4,
        }),
    } as any;
    const isolated = new EmbeddingService(dynamicConfig);
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0, 1, 0, 0] }] }) });
    (global as any).fetch = fetchMock;
    try {
      await expect(isolated.embedOne('same text')).resolves.toEqual([1, 0, 0, 0]);
      await expect(isolated.embedOne('same text')).resolves.toEqual([0, 1, 0, 0]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });
});
