import { allocateGraphExtractionChunks, GraphMissFeedback, selectGraphExtractionChunks } from './extraction-budget';

describe('graph extraction coverage', () => {
  it('samples across the entire document without favoring language or tables', () => {
    const chunks = Array.from({ length: 101 }, (_, i) => ({ content: i < 20 ? '| 表格 |' : `paragraph ${i}` }));
    expect(selectGraphExtractionChunks(chunks, 5).map(row => row.idx)).toEqual([0, 25, 50, 75, 100]);
  });
  it('keeps every segment in full mode and respects a zero budget', () => {
    expect(selectGraphExtractionChunks(['a', 'b', 'c'], 10).map(row => row.chunk)).toEqual(['a', 'b', 'c']);
    expect(selectGraphExtractionChunks(['a'], 0)).toEqual([]);
  });

  it('preserves document coverage while prioritizing uncertain chunks', () => {
    const chunks = Array.from({ length: 10 }, (_, idx) => `chunk-${idx}`);
    const selected = allocateGraphExtractionChunks(chunks, 0.5, 10, [0, 0, 0, 0, 0, 0, 0, 0, 8, 0]);
    expect(selected.map(row => row.idx)).toEqual([0, 2, 4, 5, 8, 9]);
    expect(selected[0].idx).toBe(0);
    expect(selected[selected.length - 1].idx).toBe(9);
    expect(selected.some(row => row.idx === 8)).toBe(true);
  });

  it('increases sampling for uncertainty and never exceeds the hard cap', () => {
    const chunks = Array.from({ length: 20 }, (_, idx) => `chunk-${idx}`);
    const baseline = allocateGraphExtractionChunks(chunks, 0.5, 20, []);
    const expanded = allocateGraphExtractionChunks(chunks, 0.5, 20, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const capped = allocateGraphExtractionChunks(chunks, 1, 4, Array(20).fill(5));
    expect(expanded.length).toBeGreaterThan(baseline.length);
    expect(capped).toHaveLength(4);
    expect(capped).toHaveLength(4);
    expect(capped.map(row => row.idx)).toContain(19);
  });

  it('isolates miss feedback by KB and knowledge-version scope', () => {
    const feedback = new GraphMissFeedback();
    feedback.record(['kb-a@v1'], ['rare concept'], 1_000);
    expect(feedback.score('kb-a@v1', 'A rare concept appears', 2_000)).toBeGreaterThan(0);
    expect(feedback.score('kb-b@v1', 'A rare concept appears', 2_000)).toBe(0);
    expect(feedback.score('kb-a@v2', 'A rare concept appears', 2_000)).toBe(0);
    expect(feedback.identity('kb-a@v1', 2_000)).toEqual([['rare concept', 1]]);
  });

  it('expires feedback after 24 hours and bounds terms and scopes', () => {
    const feedback = new GraphMissFeedback();
    const terms = Array.from({ length: 120 }, (_, idx) => `term-${idx}`);
    feedback.record(['kb-0'], terms, 10_000);
    expect(feedback.identity('kb-0', 10_001)).toHaveLength(16);
    for (let offset = 16; offset < terms.length; offset += 16) {
      feedback.record(['kb-0'], terms.slice(offset, offset + 16), 10_001);
    }
    expect(feedback.identity('kb-0', 10_002)).toHaveLength(100);
    expect(feedback.score('kb-0', 'term-0', 10_000 + 86400000)).toBe(0);

    feedback.record(Array.from({ length: 129 }, (_, idx) => `kb-${idx}`), ['shared phrase'], 20_000);
    expect(feedback.identity('kb-0', 20_001)).toEqual([]);
    expect(feedback.identity('kb-1', 20_001)).toEqual([['shared phrase', 1]]);
    expect(feedback.identity('kb-128', 20_001)).toEqual([['shared phrase', 1]]);
  });
});
