import { HybridRetrievalService, lateInteractionScore } from './hybrid-retrieval.service';
import * as failopen from '../observability/failopen';

/**
 * The sparse arm is a recall channel: when it degrades it must fail open
 * (return nothing and record the degradation) rather than throw and take the
 * whole answer down, and it must never query when there is nothing to query.
 * MaxSim is pinned numerically because a sign or normalisation slip there
 * reorders every late-interaction candidate silently.
 */
describe('lateInteractionScore (ColBERT MaxSim)', () => {
  it('returns 0 when either side has no vectors', () => {
    expect(lateInteractionScore([], [[1, 0]])).toBe(0);
    expect(lateInteractionScore([[1, 0]], [])).toBe(0);
  });

  it('is 1 when every query token has an identical document token', () => {
    expect(lateInteractionScore([[1, 0], [0, 1]], [[0, 1], [1, 0]])).toBeCloseTo(1, 10);
  });

  it('averages each query token best match rather than summing', () => {
    // Token A matches perfectly (1); token B is orthogonal to every doc token (0).
    expect(lateInteractionScore([[1, 0], [0, 1]], [[1, 0]])).toBeCloseTo(0.5, 10);
  });

  it('is invariant to vector magnitude', () => {
    expect(lateInteractionScore([[2, 0]], [[5, 0]])).toBeCloseTo(1, 10);
  });

  it('treats a zero vector as no similarity instead of dividing by zero', () => {
    expect(lateInteractionScore([[0, 0]], [[1, 0]])).toBe(0);
  });
});

describe('HybridRetrievalService.searchSparse', () => {
  const makeEmbedding = (over: Record<string, any> = {}) => ({
    isHybridEnabled: jest.fn(() => true),
    getConfig: jest.fn(async () => null),
    embedHybridOne: jest.fn(async () => ({ sparse: { indices: [1, 2], values: [0.5, 0.5] } })),
    ...over,
  });

  let recordFailopen: jest.SpyInstance;
  beforeEach(() => {
    recordFailopen = jest.spyOn(failopen, 'recordFailopen').mockImplementation(() => undefined as any);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does not call the embedder when the feature is disabled', async () => {
    const embedding = makeEmbedding({ isHybridEnabled: jest.fn(() => false) });
    const svc = new HybridRetrievalService(embedding as any);
    expect(await svc.searchSparse(['kb-1'], 'query')).toEqual([]);
    expect(embedding.embedHybridOne).not.toHaveBeenCalled();
  });

  it('does not call the embedder for an empty scope or blank query', async () => {
    const embedding = makeEmbedding();
    const svc = new HybridRetrievalService(embedding as any);
    expect(await svc.searchSparse([], 'query')).toEqual([]);
    expect(await svc.searchSparse(['kb-1'], '   ')).toEqual([]);
    expect(embedding.embedHybridOne).not.toHaveBeenCalled();
  });

  it('fails open and records the degradation when no sparse vector comes back', async () => {
    const embedding = makeEmbedding({ embedHybridOne: jest.fn(async () => ({ sparse: { indices: [], values: [] } })) });
    const svc = new HybridRetrievalService(embedding as any);
    expect(await svc.searchSparse(['kb-1'], 'query')).toEqual([]);
    expect(recordFailopen).toHaveBeenCalledWith('sparse');
  });

  it('caches the query representation so a repeated query embeds once', async () => {
    const embedding = makeEmbedding({ embedHybridOne: jest.fn(async () => null) });
    const svc = new HybridRetrievalService(embedding as any);
    await svc.searchSparse(['kb-1'], 'same query');
    await svc.searchSparse(['kb-1'], 'same query');
    expect(embedding.embedHybridOne).toHaveBeenCalledTimes(1);
  });
});
