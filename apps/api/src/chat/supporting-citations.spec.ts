import { selectSupportingCitations } from './supporting-citations';

describe('supporting citation selection', () => {

  it('drops citations far below the best measured score', () => {
    const kept = selectSupportingCitations([
      { docTitle: 'strong', relevanceScore: 0.86, scoreSource: 'rerank' },
      { docTitle: 'medium', relevanceScore: 0.3, scoreSource: 'rerank' },
      { docTitle: 'noise', relevanceScore: 0.00002, scoreSource: 'rerank' },
    ]);
    expect(kept.map((c) => c.docTitle)).toEqual(['strong', 'medium']);
  });

  it('keeps a single best citation when nothing reaches the ratio', () => {
    const kept = selectSupportingCitations([
      { docTitle: 'best', relevanceScore: 0.5, scoreSource: 'rerank' },
      { docTitle: 'noise', relevanceScore: 0.0001, scoreSource: 'rerank' },
    ], { minMeasuredRatio: 0.9 });
    expect(kept.map((c) => c.docTitle)).toEqual(['best']);
  });

  it('never returns an empty list when retrieval produced results', () => {
    const kept = selectSupportingCitations([{ docTitle: 'only' }, { docTitle: 'other' }]);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('respects the ratio boundary inclusively', () => {
    const kept = selectSupportingCitations([
      { docTitle: 'best', relevanceScore: 1, scoreSource: 'rerank' },
      { docTitle: 'exactly-at-threshold', relevanceScore: 0.2, scoreSource: 'rerank' },
      { docTitle: 'below', relevanceScore: 0.19, scoreSource: 'rerank' },
    ]);
    expect(kept.map((c) => c.docTitle)).toEqual(['best', 'exactly-at-threshold']);
  });
  it('drops the long-tail tail observed in production answers', () => {
    // Real shape from a QA run: one strong hit plus placement-grade noise that
    // is still tagged native and therefore counts as "measured".
    const kept = selectSupportingCitations([
      { docTitle: '01_product_spec.md', relevanceScore: 0.5076, scoreSource: 'native' },
      { docTitle: '03b_members_gbk.csv', relevanceScore: 0.0202, scoreSource: 'native' },
      { docTitle: 'n08_big.txt', relevanceScore: 0.0011, scoreSource: 'native' },
      { docTitle: '10_budget.xlsx', relevanceScore: 0.0012, scoreSource: 'native' },
    ]);
    expect(kept.map((c) => c.docTitle)).toEqual(['01_product_spec.md']);
  });

  it('keeps citations that were never scored (for example compiled cards)', () => {
    const kept = selectSupportingCitations([
      { docTitle: 'retrieved', relevanceScore: 0.9, scoreSource: 'rerank' },
      { docTitle: 'compiled-card', },
    ]);
    expect(kept.map((c) => c.docTitle)).toEqual(['retrieved', 'compiled-card']);
  });

  it('drops skipped-from-rerank tail when other evidence is scored', () => {
    const kept = selectSupportingCitations([
      { docTitle: 'strong', relevanceScore: 0.8, scoreSource: 'rerank' },
      { docTitle: 'never-reranked', rerankSkipped: true, score: 0.0002, scoreSource: 'rerank' },
    ]);
    expect(kept.map((c) => c.docTitle)).toEqual(['strong']);
  });
 });
