import { estimateTokens, fitEvidenceContext } from './context-budget';
describe('model context budget', () => {
  it('accounts conservatively for CJK text', () => {
    expect(estimateTokens('企业知识库')).toBe(5);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
  it('keeps citation numbering aligned after truncation', () => {
    const result = fitEvidenceContext([
      { docTitle: '一', context: '制度内容'.repeat(30) },
      { docTitle: '二', context: '第二份内容'.repeat(30) },
    ], 80);
    expect(result.citations).toHaveLength(1);
    expect(result.context).toContain('【来源 1】');
    expect(result.context).not.toContain('【来源 2】');
    expect(result.estimatedTokens).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
  });
});
