import { CitationAssemblyService } from './citation-assembly';

describe('selectEvidence summary-section preference (P2-03)', () => {
  const svc = new CitationAssemblyService({
    logger: { debug: () => undefined, warn: () => undefined, log: () => undefined } as any,
  });

  const detail = (i: number) => ({
    docId: 'doc-1',
    documentId: 'doc-1',
    kbId: 'kb-1',
    topic: '22_assessment_2krows.xlsx',
    docTitle: '22_assessment_2krows.xlsx',
    section: '## 考核表',
    evidence: `## 考核表\n| 序号 | 项目 | 得分 |\n| ${i} | 考核项${i} | 80 |`,
    context: `## 考核表\n| ${i} | 考核项${i} | 80 |`,
    score: 0.99 - i * 0.001,
    relevanceScore: 0.99 - i * 0.001,
    rerankScore: 0.99 - i * 0.001,
  });

  const summary = {
    docId: 'doc-1',
    documentId: 'doc-1',
    kbId: 'kb-1',
    topic: '22_assessment_2krows.xlsx',
    docTitle: '22_assessment_2krows.xlsx',
    section: '## 汇总',
    evidence: '## 汇总\n| 锚点事实 | XLSX-KEY-汇总表编号SUM-2026-5566 |',
    context: '## 汇总\n| 锚点事实 | SUM-2026-5566 |',
    score: 0.55,
    relevanceScore: 0.55,
    rerankScore: 0.55,
  };

  it('puts summary-section chunks into the selected context when question names 汇总表', () => {
    const result = {
      citations: [detail(1), detail(2), detail(3), detail(4), { ...summary }],
    };
    const out = svc.selectEvidence(result, {
      breadth: false,
      tokenBudget: 4000,
      subQueries: [],
      question: '考核汇总表的编号是多少？',
    });
    const texts = (out.citations || []).map((c: any) => String(c.evidence || c.context || c.snippet || ''));
    expect(texts.some((t: string) => t.includes('SUM-2026-5566') || t.includes('汇总'))).toBe(true);
  });
});


describe('contextual prefix must not flip detail tables into summary', () => {
  const svc = new CitationAssemblyService({
    logger: { debug: () => undefined, warn: () => undefined, log: () => undefined } as any,
  });
  it('keeps detail rows out of summary preference when only the prefix mentions 汇总', () => {
    const detailWithPrefix = {
      docId: 'doc-1',
      documentId: 'doc-1',
      topic: '22_assessment_2krows.xlsx',
      docTitle: '22_assessment_2krows.xlsx',
      evidence: '[上下文: 该文本块位于文档《22_assessment_2krows.xlsx》的汇总统计之后的考核表明细。]\n\n## 考核表\n| 1 | 考核项1 | 80 |',
      context: '[上下文: 该文本块位于文档《22_assessment_2krows.xlsx》的汇总统计之后的考核表明细。]\n\n## 考核表\n| 1 | 考核项1 | 80 |',
      score: 0.99,
      relevanceScore: 0.99,
      rerankScore: 0.99,
    };
    const summary = {
      docId: 'doc-1',
      documentId: 'doc-1',
      topic: '22_assessment_2krows.xlsx',
      docTitle: '22_assessment_2krows.xlsx',
      evidence: '[上下文: 位于汇总部分。]\n\n## 汇总\n| 锚点事实 | SUM-2026-5566 |',
      context: '[上下文: 位于汇总部分。]\n\n## 汇总\n| 锚点事实 | SUM-2026-5566 |',
      score: 0.5,
      relevanceScore: 0.5,
      rerankScore: 0.5,
    };
    const out = svc.selectEvidence({ citations: [detailWithPrefix, summary] }, {
      breadth: false,
      tokenBudget: 4000,
      subQueries: [],
      question: '考核汇总表的编号是多少？',
    });
    const texts = (out.citations || []).map((c: any) => String(c.evidence || c.context || ''));
    expect(texts[0]).toContain('SUM-2026-5566');
  });
});
