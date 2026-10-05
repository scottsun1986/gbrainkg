import { FusionRerankService } from './fusion-rerank';
import { metricsService } from '../observability/metrics.service';

/**
 * P1-6: every cross-encoder call must be observable — duration histogram for
 * P95 plus outcome accounting per pool-size bucket — because a rerank that
 * fails open to arm scores is silently worse than a smaller capped call, and
 * capacity tuning without these numbers is blind.
 */
describe('rerank call metrics (P1-6)', () => {
  const originalFetch = global.fetch;
  let service: any;

  beforeEach(() => {
    service = Object.create(FusionRerankService.prototype);
    service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };
    service.rerankCache = new Map();
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

  const countOf = (text: string, name: string, labels: string): number => {
    const line = text.split('\n').find((l) => l.startsWith(name) && l.includes(labels));
    return line ? Number(line.split(' ').pop()) : 0;
  };

  it('records duration and ok outcome for a successful whole-pool rerank', async () => {
    const fetchMock = jest.fn(async (_url: string, init: any) => {
      const docs: string[] = JSON.parse(String(init?.body || '{}')).documents || [];
      return {
        ok: true,
        json: async () => ({ results: docs.map((_, index) => ({ index, relevance_score: 0.5 })) }),
      };
    });
    (global as any).fetch = fetchMock;
    const citations = Array.from({ length: 70 }, (_, i) => ({
      evidence: `evidence text ${i}`,
      score: 0.5,
      scoreSource: 'native',
    }));
    const out = await service.applyRerank('question', { citations, reranked: false });
    expect(out.reranked).toBe(true);

    const text = metricsService.render();
    // Cascade caps the CE pool at RERANK_MAX_DOCS=60, so 70 recalled
    // candidates send 60 — the 31_60 bucket; labels render alphabetically
    // (docs,kind,outcome). The histogram series exists so P95 is queryable.
    expect(countOf(text, 'rerank_calls_total', 'outcome="ok"')).toBeGreaterThanOrEqual(1);
    expect(text).toContain('docs="31_60"');
    expect(text).toContain('rerank_call_ms');
    expect(text).toContain('kind="pool"');
  });

  it('classifies a timeout-shaped failure as outcome=timeout', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    (timeoutError as any).name = 'TimeoutError';
    (global as any).fetch = jest.fn().mockRejectedValue(timeoutError);
    const citations = Array.from({ length: 5 }, (_, i) => ({
      evidence: `evidence text ${i}`,
      score: 0.5,
      scoreSource: 'native',
    }));
    // applyRerank fails open and returns the input unchanged; the metric must
    // still record the timeout.
    await service.applyRerank('question', { citations, reranked: false });
    const text = metricsService.render();
    expect(countOf(text, 'rerank_calls_total', 'outcome="timeout"')).toBeGreaterThanOrEqual(1);
  });
});
