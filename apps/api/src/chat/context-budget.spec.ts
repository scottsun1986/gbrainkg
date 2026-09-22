import { estimateTokens, resolveContextTokenBudget } from './context-budget';
describe('model context budget', () => {
  describe('resolveContextTokenBudget', () => {
    const original = process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET;
    afterEach(() => {
      if (original === undefined) delete process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET;
      else process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET = original;
    });

    it('honours an explicit override', () => {
      process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET = '5000';
      expect(resolveContextTokenBudget({ breadth: true, complexity: 'multi_hop' })).toBe(5000);
    });

    it('scales with complexity and sub-query count', () => {
      delete process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET;
      const simple = resolveContextTokenBudget({ breadth: false, complexity: 'simple' });
      const multiHop = resolveContextTokenBudget({ breadth: false, complexity: 'multi_hop' });
      const withSubs = resolveContextTokenBudget({
        breadth: false,
        complexity: 'simple',
        subQueryCount: 2,
      });
      expect(multiHop).toBeGreaterThan(simple);
      expect(withSubs).toBeGreaterThan(simple);
    });

    it('clamps to the configured maximum', () => {
      delete process.env.RETRIEVAL_CONTEXT_TOKEN_BUDGET;
      const budget = resolveContextTokenBudget({
        breadth: true,
        complexity: 'multi_hop',
        subQueryCount: 4,
        evidenceCount: 40,
      });
      expect(budget).toBeLessThanOrEqual(12000);
    });
  });

  it('accounts conservatively for CJK text', () => {
    expect(estimateTokens('企业知识库')).toBe(5);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});
