import { HybridRetrievalService, lateInteractionScore } from './hybrid-retrieval.service';
import * as failopen from '../observability/failopen';
import { runWithRequestContext } from '../observability/request-context';

const mockPrisma: any = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  // boundedReadSql sets statement_timeout through $queryRaw and then runs the
  // probe against the same surface.
  $transaction: jest.fn(async (fn: any) => fn({ $queryRaw: mockPrisma.$queryRaw })),
};
jest.mock('../prisma', () => ({ getPrismaClient: jest.fn(() => mockPrisma) }));

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

  it('applies the readable-document predicate inside the ranked CTE before LIMIT', async () => {
    const embedding = makeEmbedding();
    const svc = new HybridRetrievalService(embedding as any);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const userId = '11111111-1111-4111-8111-111111111111';
    await runWithRequestContext({ requestId: 'f03-test', userId }, () =>
      svc.searchSparse(['22222222-2222-4222-8222-222222222222'], 'query', 5),
    );
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    const calls = mockPrisma.$queryRaw.mock.calls;
    // Rebuild the tagged template faithfully: strings[0] value[0] strings[1]…
    // Nested Prisma.Sql fragments (the readable-document predicate) arrive as
    // interpolated values with a rendered `.text`. The last call is the ranked
    // sparse probe (set_config runs first).
    const renderTagged = (args: any[]) => {
      const strings = args[0] as string[];
      let out = '';
      for (let i = 0; i < strings.length; i += 1) {
        out += strings[i];
        if (i < args.length - 1) {
          const value = args[i + 1];
          out += typeof value?.text === 'string' ? value.text : String(value);
        }
      }
      return out;
    };
    const sql = renderTagged(calls[calls.length - 1]);
    const rankedIdx = sql.indexOf('ranked AS');
    const aclIdx = sql.indexOf('"DocumentAcl"');
    const limitIdx = sql.lastIndexOf('LIMIT');
    expect(rankedIdx).toBeGreaterThan(-1);
    // Authorization (ACL) resolves where the candidate set is built, and the
    // LIMIT that used to truncate unreadable rows away from the TopK comes after.
    expect(aclIdx).toBeGreaterThan(rankedIdx);
    expect(aclIdx).toBeLessThan(limitIdx);
    // The whole probe runs under a server-side statement budget: boundedRead
    // sets statement_timeout for the transaction before the probe executes.
    const allSql = calls.map((call: any[]) => renderTagged(call)).join('\n');
    expect(allSql).toContain('statement_timeout');
  });
});
