import { coarseSelectRerankPool } from './fusion-rerank';

/**
 * Two-stage rerank cascade (review §3.2): with RERANK_MAX_DOCS back at 60,
 * the coarse stage must not be a plain head slice — a probe channel whose
 * strong hits sit below the cap would lose its recall entirely (根因 1), and
 * every overflow candidate would fall into un-measured territory (P0-2).
 */
describe('coarseSelectRerankPool (cascade coarse stage)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('preserves every probe channel head candidates beyond the cap position', () => {
    delete process.env.RERANK_CASCADE_CHANNEL_HEADS;
    // 70 primary candidates occupy every head slot of a plain slice(0, 60);
    // the two probe channels sit entirely below the cap.
    const citations = [
      ...Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, evidence: `primary ${i}` })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, evidence: `probe-a ${i}`, subQueryOrigin: '考勤 V2 迟到' })),
      ...Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, evidence: `probe-b ${i}`, subQueryOrigin: '考勤 V1 迟到' })),
    ];
    const pool = coarseSelectRerankPool(citations, 60);
    expect(pool).toHaveLength(60);
    const ids = new Set(pool.map((c: any) => c.id));
    // Default 3 head candidates per channel are guaranteed pool slots.
    for (const id of ['a0', 'a1', 'a2', 'b0', 'b1', 'b2']) {
      expect(ids.has(id)).toBe(true);
    }
    // The rest fills by merged rank: 3×3 channel heads + rank fill to 60
    // reaches p53; the deep primary tail stays out.
    expect(ids.has('p0')).toBe(true);
    expect(ids.has('p53')).toBe(true);
    expect(ids.has('p54')).toBe(false);
    expect(ids.has('p69')).toBe(false);
  });

  it('honours an explicit RERANK_CASCADE_CHANNEL_HEADS override', () => {
    process.env.RERANK_CASCADE_CHANNEL_HEADS = '1';
    const citations = [
      ...Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, evidence: `primary ${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, evidence: `probe ${i}`, subQueryOrigin: 'probe q' })),
    ];
    const pool = coarseSelectRerankPool(citations, 60);
    const ids = new Set(pool.map((c: any) => c.id));
    expect(ids.has('a0')).toBe(true);
    expect(ids.has('a1')).toBe(false);
  });

  it('orders by attached MaxSim coarse scores when present', () => {
    const citations = [
      { id: 'low-maxsim', evidence: 'x', maxsimScore: 0.12 },
      { id: 'high-maxsim', evidence: 'y', maxsimScore: 0.91 },
      { id: 'no-score', evidence: 'z' },
    ];
    const pool = coarseSelectRerankPool(citations, 2);
    expect(pool.map((c: any) => c.id)).toEqual(['high-maxsim', 'low-maxsim']);
  });

  it('returns everything when the pool is already within the cap', () => {
    const citations = [{ id: 'a' }, { id: 'b' }];
    expect(coarseSelectRerankPool(citations, 60)).toHaveLength(2);
  });
});
