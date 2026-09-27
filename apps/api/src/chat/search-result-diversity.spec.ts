import { selectDiverseSearchCitations } from './search-result-diversity';

describe('selectDiverseSearchCitations', () => {
  it('promotes distinct documents above repeated high-scoring chunks', () => {
    const candidates = [
      { docId: 'a', chunkId: 'a1', score: 0.99, evidence: 'a one' },
      { docId: 'a', chunkId: 'a2', score: 0.98, evidence: 'a two' },
      { docId: 'a', chunkId: 'a3', score: 0.97, evidence: 'a three' },
      { docId: 'b', chunkId: 'b1', score: 0.8, evidence: 'b one' },
      { docId: 'c', chunkId: 'c1', score: 0.7, evidence: 'c one' },
    ];
    expect(selectDiverseSearchCitations(candidates, 3).map((c) => c.chunkId))
      .toEqual(['a1', 'b1', 'c1']);
    // Selection does not mutate or drop the underlying candidate pool.
    expect(candidates.map((c) => c.chunkId)).toEqual(['a1', 'a2', 'a3', 'b1', 'c1']);
  });

  it('keeps separate passages from one document when slots remain', () => {
    const candidates = [
      { docId: 'a', chunkId: 'a1', score: 0.9, evidence: 'first fact' },
      { docId: 'a', chunkId: 'a2', score: 0.8, evidence: 'second fact' },
      { docId: 'b', chunkId: 'b1', score: 0.7, evidence: 'bridge fact' },
    ];
    expect(selectDiverseSearchCitations(candidates, 3).map((c) => c.chunkId))
      .toEqual(['a1', 'a2', 'b1']);
  });

  it('gives a competitive hop a bounded place while preserving the best two documents', () => {
    const candidates = [
      { docId: 'a', score: 0.99, evidence: 'first' },
      { docId: 'b', score: 0.95, evidence: 'second' },
      { docId: 'c', score: 0.94, evidence: 'third' },
      { docId: 'd', score: 0.93, evidence: 'fourth' },
      { docId: 'e', score: 0.92, evidence: 'fifth' },
      { docId: 'f', score: 0.80, evidence: 'bridge', subQueryOrigin: 'second hop' },
      { docId: 'g', score: 0.20, evidence: 'noise', subQueryOrigin: 'third hop' },
    ];
    const picked = selectDiverseSearchCitations(candidates, 4);
    expect(picked.slice(0, 2).map((c) => c.docId)).toEqual(['a', 'b']);
    expect(picked.map((c) => c.docId)).toEqual(['a', 'b', 'c', 'f']);
    expect(picked.some((c) => c.docId === 'g')).toBe(false);
  });

  it('does not merge different unidentified sources by their shared title or empty evidence', () => {
    const candidates = [{ score: 0.9 }, { score: 0.8 }];
    expect(selectDiverseSearchCitations(candidates, 2)).toHaveLength(2);
  });

  it('can use a second document from a hop when its first hit repeats a selected document', () => {
    const candidates = [
      { docId: 'a', score: 0.99, evidence: 'primary a' },
      { docId: 'b', score: 0.95, evidence: 'primary b' },
      { docId: 'a', score: 0.90, evidence: 'probe a', subQueryOrigin: 'hop two' },
      { docId: 'c', score: 0.80, evidence: 'probe c', subQueryOrigin: 'hop two' },
      { docId: 'd', score: 0.75, evidence: 'primary d' },
    ];
    expect(selectDiverseSearchCitations(candidates, 4).map((c) => c.docId))
      .toEqual(['a', 'b', 'c', 'd']);
  });
});
