import { CitationAssemblyService } from './citation-assembly';

/**
 * One entailment call for every held sentence used to run just past the 6 s
 * timeout on long answers, and the timeout dropped ALL held sentences at once
 * (production: a "V1 vs V2" comparison lost its whole first section and left a
 * bare heading). The judge now works in small parallel batches and retries a
 * failed batch once, so one slow call costs at most that batch.
 */
describe('judgeEntailment batching', () => {
  const logger = { debug: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined } as any;
  const build = () =>
    new CitationAssemblyService({
      logger,
      prisma: {} as any,
      permissionService: {} as any,
      documentAclService: {} as any,
    } as any);

  const OLD_ENV = process.env.SEMANTIC_COVERAGE_BATCH_SIZE;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.SEMANTIC_COVERAGE_BATCH_SIZE;
    else process.env.SEMANTIC_COVERAGE_BATCH_SIZE = OLD_ENV;
  });

  it('splits statements into batches and maps local indexes back to global ones', async () => {
    const svc = build();
    const calls: string[][] = [];
    jest.spyOn(svc as any, 'judgeEntailmentBatch').mockImplementation(async (batch: any) => {
      calls.push(batch);
      // Each batch supports its first statement only.
      return new Set([0]);
    });
    const statements = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
    const result = await svc.judgeEntailment(statements, 'evidence');
    expect(calls).toEqual([['s0', 's1', 's2'], ['s3', 's4', 's5'], ['s6']]);
    expect([...result].sort()).toEqual([0, 3, 6]);
  });

  it('retries a failed batch once and keeps the other batches', async () => {
    const svc = build();
    const attempts = new Map<string, number>();
    jest.spyOn(svc as any, 'judgeEntailmentBatch').mockImplementation(async (batch: any) => {
      const key = batch.join(',');
      const n = (attempts.get(key) || 0) + 1;
      attempts.set(key, n);
      // The first batch times out on its first attempt only.
      if (key === 's0,s1,s2' && n === 1) return null;
      return new Set(batch.map((_: string, i: number) => i));
    });
    const result = await svc.judgeEntailment(['s0', 's1', 's2', 's3'], 'evidence');
    expect(attempts.get('s0,s1,s2')).toBe(2);
    expect(attempts.get('s3')).toBe(1);
    expect([...result].sort()).toEqual([0, 1, 2, 3]);
  });

  it('a batch that fails twice drops only its own statements', async () => {
    const svc = build();
    jest.spyOn(svc as any, 'judgeEntailmentBatch').mockImplementation(async (batch: any) =>
      batch[0] === 's0' ? null : new Set(batch.map((_: string, i: number) => i)),
    );
    const result = await svc.judgeEntailment(['s0', 's1', 's2', 's3', 's4'], 'evidence');
    expect([...result].sort()).toEqual([3, 4]);
  });

  it('honours SEMANTIC_COVERAGE_BATCH_SIZE', async () => {
    process.env.SEMANTIC_COVERAGE_BATCH_SIZE = '2';
    const svc = build();
    const sizes: number[] = [];
    jest.spyOn(svc as any, 'judgeEntailmentBatch').mockImplementation(async (batch: any) => {
      sizes.push(batch.length);
      return new Set<number>();
    });
    await svc.judgeEntailment(['a', 'b', 'c', 'd', 'e'], 'evidence');
    expect(sizes).toEqual([2, 2, 1]);
  });

  it('returns empty without calling the judge for empty input', async () => {
    const svc = build();
    const spy = jest.spyOn(svc as any, 'judgeEntailmentBatch');
    expect((await svc.judgeEntailment([], 'evidence')).size).toBe(0);
    expect((await svc.judgeEntailment(['a'], '   ')).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
