import {
  applySectionAlign,
  classifyTableRole,
  extractSectionAnchors,
  sectionAlignMultiplier,
} from './section-align';

describe('section-align', () => {
  it('extracts section anchors from Chinese compound names', () => {
    const anchors = extractSectionAnchors('考核汇总表的编号是多少？');
    expect(anchors).toContain('考核汇总表');
    expect(anchors).toContain('考核汇总');
    expect(anchors.some((a) => a.includes('汇总'))).toBe(true);
  });

  it('classifies summary vs detail tables structurally', () => {
    expect(classifyTableRole({ rowCount: 2, section: '汇总' })).toBe('summary');
    expect(classifyTableRole({ rowCount: 2000, headerText: '考核项得分' })).toBe('detail');
    expect(classifyTableRole({ headerText: '汇总统计' })).toBe('summary');
    expect(classifyTableRole({ headerText: '人员明细' })).toBe('detail');
  });

  it('boosts summary section when query names it', () => {
    const q = '考核汇总表的编号是多少？';
    const summary = {
      section: '汇总',
      breadcrumb: '22_assessment_2krows.xlsx > 汇总',
      headingHierarchy: ['汇总'],
      tableRole: 'summary',
      evidence: '## 汇总\n| 锚点事实 | XLSX-KEY-汇总表编号SUM-2026-5566 |',
    };
    const detail = {
      section: '考核表',
      breadcrumb: '22_assessment_2krows.xlsx > 考核表',
      headingHierarchy: ['考核表'],
      tableRole: 'detail',
      evidence: '## 考核表\n' + '| 1227 | 考核项1227 | 82.3 |\n'.repeat(80),
    };
    expect(sectionAlignMultiplier(q, summary)).toBeGreaterThan(1.2);
    expect(sectionAlignMultiplier(q, detail)).toBeLessThan(1.0);
  });

  it('reorders scores so summary wins over detail', () => {
    const q = '考核汇总表的编号是多少？';
    const citations = [
      { score: 0.99, section: '考核表', tableRole: 'detail', evidence: '|1|2|\n'.repeat(100) },
      { score: 0.97, section: '汇总', tableRole: 'summary', evidence: 'SUM-2026-5566' },
    ];
    applySectionAlign(q, citations);
    expect(Number(citations[1].score)).toBeGreaterThan(Number(citations[0].score));
  });

  it('leaves neutral questions unchanged', () => {
    const c = { score: 0.9, section: '附则', tableRole: 'unknown', evidence: '一般条款' };
    const m = sectionAlignMultiplier('今天天气怎么样', c);
    expect(m).toBe(1);
  });
});
