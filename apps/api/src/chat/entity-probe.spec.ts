import { QueryRewriterService } from './query-rewriter';

/**
 * LLM-named entity probes.
 *
 * The multi-hop bottleneck is *naming* the second-hop entity: measured on MuSiQue, 36 of
 * the 40 gold paragraphs the pipeline misses are retrievable at rank 1 when used directly
 * as the query. Regex-extracted entities were rejected twice (prose fragments), so the
 * naming step is delegated to the model — but only as an opt-in: measured quality was
 * neutral (R@10 0.7642 vs 0.7617) at 2.3x the latency, so it ships disabled.
 */
describe('planEntityProbesWithLlm', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  let service: any;

  beforeEach(() => {
    service = Object.create(QueryRewriterService.prototype);
    service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.modelConfigService = {
      getDefault: jest.fn().mockResolvedValue({
        provider: { baseUrl: 'https://llm.example.com/v1', apiKey: 'k' },
        modelName: 'fast',
      }),
    };
    process.env.RETRIEVAL_LLM_ENTITY_PROBES = 'true';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    (global as any).fetch = originalFetch;
  });

  it('returns the named entities the model proposes', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"entities":["George Stevens","Douglas Sirk","George Stevens"]}' } }],
      }),
    });
    const probes = await service.planEntityProbesWithLlm('Which film has the director who died later?', [
      'The More the Merrier was directed by George Stevens.',
    ]);
    expect(probes).toEqual(['George Stevens', 'Douglas Sirk']);
  });

  it('stays off unless explicitly enabled', async () => {
    process.env.RETRIEVAL_LLM_ENTITY_PROBES = 'false';
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    await expect(
      service.planEntityProbesWithLlm('Q', ['evidence text long enough']),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails open when the model errors or returns junk', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('llm down'));
    await expect(service.planEntityProbesWithLlm('Q', ['evidence'])).resolves.toEqual([]);
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    });
    await expect(service.planEntityProbesWithLlm('Q', ['evidence'])).resolves.toEqual([]);
  });
});
