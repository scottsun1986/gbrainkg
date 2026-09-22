import { FusionRerankService } from './fusion-rerank';

/**
 * Per-probe-group cross-encoder reranking.
 *
 * A cross-encoder scores a candidate against one query. Scoring the merged pool
 * against the original question alone could not rank second-hop evidence (measured
 * on the 2Wiki bridge question, both director pages fell out of the top-10 while the
 * two film pages stayed on top). Each probe group is therefore scored against the
 * probe that found it, and the groups are weighted so probe evidence can enter the
 * top-k without outranking an equally relevant primary hit.
 */
describe('rerankByProbeGroups', () => {
  const originalFetch = global.fetch;
  let service: any;

  beforeEach(() => {
    service = Object.create(FusionRerankService.prototype);
    service.modelConfigService = {
      getDefault: jest.fn().mockResolvedValue({
        provider: { baseUrl: 'https://rerank.example.com/v1', apiKey: 'k' },
        modelName: 'reranker',
      }),
    };
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  const mockRerank = () =>
    jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const docs: string[] = body.documents || [];
      return {
        ok: true,
        json: async () => ({
          results: docs.map((_, index) => ({ index, relevance_score: Number((0.9 - index * 0.1).toFixed(4)) })),
        }),
      };
    });

  it('scores each probe group against its own probe and weights the groups', async () => {
    const fetchMock = mockRerank();
    (global as any).fetch = fetchMock;
    const citations: any[] = [
      { evidence: 'primary A', score: 0.95, scoreSource: 'synthetic' },
      { evidence: 'primary B', score: 0.9, scoreSource: 'synthetic' },
      { evidence: 'probe A', score: 0.95, scoreSource: 'synthetic', subQueryOrigin: 'Sleep, My Love director' },
      { evidence: 'probe B', score: 0.9, scoreSource: 'synthetic', subQueryOrigin: 'Sleep, My Love director' },
    ];

    await service.rerankByProbeGroups('Which film has the director who died later?', citations);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const queries = fetchMock.mock.calls
      .map((call: any[]) => JSON.parse(String(call[1]?.body || '{}')).query)
      .sort();
    expect(queries).toEqual(['Sleep, My Love director', 'Which film has the director who died later?'].sort());

    // Primary group keeps weight 1, probe group is scaled to 0.9 for ordering…
    expect(citations[0].score).toBeCloseTo(0.9, 3);
    expect(citations[2].score).toBeCloseTo(0.81, 3);
    // …while the raw calibrated score stays available for the confidence gates.
    expect(citations[2].relevanceScore).toBeCloseTo(0.9, 3);
    expect(citations[2].scoreSource).toBe('rerank');
    expect(citations[2].rerankQuery).toBe('Sleep, My Love director');
  });

  it('fails open, leaving arm scores untouched when the reranker errors', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('rerank down'));
    const citations: any[] = [
      { evidence: 'primary A', score: 0.95, scoreSource: 'synthetic' },
      { evidence: 'primary B', score: 0.9, scoreSource: 'synthetic' },
      { evidence: 'probe A', score: 0.8, scoreSource: 'synthetic', subQueryOrigin: 'probe q' },
      { evidence: 'probe B', score: 0.7, scoreSource: 'synthetic', subQueryOrigin: 'probe q' },
    ];

    await expect(service.rerankByProbeGroups('Q', citations)).resolves.toBeUndefined();
    expect(citations[0].score).toBe(0.95);
    expect(citations[2].score).toBe(0.8);
    expect(citations[2].scoreSource).toBe('synthetic');
  });

  it('does nothing when no rerank route is configured', async () => {
    service.modelConfigService = { getDefault: jest.fn().mockResolvedValue(null) };
    const fetchMock = mockRerank();
    (global as any).fetch = fetchMock;
    const citations: any[] = [
      { evidence: 'a', score: 0.9 },
      { evidence: 'b', score: 0.8 },
    ];
    await service.rerankByProbeGroups('Q', citations);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The chat path previously cross-encoded the whole pool against the original question,
 * which cannot rank second-hop evidence. It now uses the same per-probe-group rerank
 * whenever probe evidence is present, and falls back to the whole-pool rerank
 * otherwise (no probes, referential query, or reranker failure).
 */
describe('rerankPool (chat path)', () => {
  const originalEnv = { ...process.env };
  let service: any;
  let groupRerank: jest.Mock;
  let wholePoolRerank: jest.Mock;

  beforeEach(() => {
    service = Object.create(FusionRerankService.prototype);
    service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.isSelfContainedQuery = () => true;
    groupRerank = jest.fn(async (_q: string, citations: any[]) => {
      citations.forEach((citation) => {
        citation.scoreSource = 'rerank';
        citation.score = 0.5;
      });
    });
    wholePoolRerank = jest.fn(async (_q: string, result: any) => ({
      ...result,
      reranked: true,
      platformRerankApplied: true,
      viaWholePool: true,
    }));
    service.rerankByProbeGroups = groupRerank;
    service.applyRerank = wholePoolRerank;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const probed = () => ({
    citations: [
      { evidence: 'primary', score: 0.9 },
      { evidence: 'hop 2', score: 0.8, subQueryOrigin: 'Douglas Sirk' },
    ],
  });

  it('reranks per probe group when probe evidence is present', async () => {
    const result = await service.rerankPool('Which film has the director who died later?', probed(), false);
    expect(groupRerank).toHaveBeenCalledTimes(1);
    expect(wholePoolRerank).not.toHaveBeenCalled();
    expect(result.reranked).toBe(true);
  });

  it('falls back to the whole-pool rerank without probes', async () => {
    const result = await service.rerankPool('Q', { citations: [{ evidence: 'a' }, { evidence: 'b' }] }, false);
    expect(groupRerank).not.toHaveBeenCalled();
    expect(result.viaWholePool).toBe(true);
  });

  it('keeps the arm order for referential queries', async () => {
    service.isSelfContainedQuery = () => false;
    const result = await service.rerankPool('那它具体是怎么定义的', probed(), false);
    expect(groupRerank).not.toHaveBeenCalled();
    expect(result.viaWholePool).toBe(true);
  });

  it('honours the kill switch and falls back when the group rerank scores nothing', async () => {
    process.env.RETRIEVAL_CHAT_GROUP_RERANK = 'false';
    await service.rerankPool('Q', probed(), false);
    expect(groupRerank).not.toHaveBeenCalled();

    delete process.env.RETRIEVAL_CHAT_GROUP_RERANK;
    service.rerankByProbeGroups = jest.fn(async () => undefined); // provider down → fail-open
    const result = await service.rerankPool('Q', probed(), false);
    expect(result.viaWholePool).toBe(true);
  });
});
