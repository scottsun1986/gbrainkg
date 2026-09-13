import { buildBm25Pool, bm25Scores } from './lexical-bm25';

describe('lexical-bm25', () => {
  it('handles empty entries or keywords gracefully', () => {
    const emptyPool = buildBm25Pool([], ['test']);
    expect(emptyPool.N).toBe(0);
    expect(bm25Scores(emptyPool).size).toBe(0);

    const poolNoKws = buildBm25Pool([{ id: '1', text: 'hello world' }], []);
    expect(poolNoKws.N).toBe(1);
    expect(bm25Scores(poolNoKws).size).toBe(0);
  });

  it('correctly tracks document length without keyword bias', () => {
    const text = 'apple banana apple cherry';
    const pool = buildBm25Pool([{ id: '1', text }], ['apple']);
    expect(pool.docs[0].len).toBe(text.length);
    expect(pool.docs[0].tf.get('apple')).toBe(2);
  });

  it('favors rarer terms across pool (IDF monotonicity)', () => {
    const entries = [
      { id: '1', text: 'rare_term common_term' },
      { id: '2', text: 'common_term other_word' },
      { id: '3', text: 'common_term another_word' },
      { id: '4', text: 'common_term yet_another' },
    ];
    const pool = buildBm25Pool(entries, ['rare_term', 'common_term']);
    const scores = bm25Scores(pool);

    // Doc 1 contains both terms; doc 2 contains only common_term
    expect(scores.get('1')).toBeGreaterThan(scores.get('2') || 0);

    // Isolated comparison: score of doc with only rare_term vs doc with only common_term of same length
    const isolatedPool = buildBm25Pool(
      [
        { id: 'rare_doc', text: 'rare_keyword boilerplate_padding' },
        { id: 'comm_doc1', text: 'comm_keyword boilerplate_padding' },
        { id: 'comm_doc2', text: 'comm_keyword boilerplate_padding' },
        { id: 'comm_doc3', text: 'comm_keyword boilerplate_padding' },
      ],
      ['rare_keyword', 'comm_keyword'],
    );
    const isolatedScores = bm25Scores(isolatedPool);
    expect(isolatedScores.get('rare_doc')!).toBeGreaterThan(isolatedScores.get('comm_doc1')!);
  });

  it('penalizes verbose boilerplate documents (length normalization)', () => {
    const shortDoc = { id: 'short', text: 'keyword match here' };
    const longDoc = {
      id: 'long',
      text: 'keyword match here ' + 'extra boilerplate text '.repeat(20),
    };
    const pool = buildBm25Pool([shortDoc, longDoc], ['keyword']);
    const scores = bm25Scores(pool);

    expect(scores.get('short')!).toBeGreaterThan(scores.get('long')!);
  });
});
