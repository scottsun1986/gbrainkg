import { CitationAssemblyService } from './citation-assembly';

/**
 * A section group is one contiguous region of a document, so a 2000-row table
 * puts every detail row and the closing「## 汇总」sheet in the SAME group. The
 * group is kept whole, but the group had no notion of a representative: the
 * summary path emitted `members[0]`, an arbitrary position inside the region.
 * P2-03 then answered HIT or MISS depending on which chunk happened to be that
 * position, which the sub-query planner varies run to run.
 *
 * The prompt renders sources in reverse order (the list is reversed for the
 * model), so the group's representative must be the LAST entry in the selected
 * citations; these cases pin that.
 *
 * The representative is now the group's best-scoring member, and for a
 * summary-question the group's summary-role member wins even when a detail row
 * of the same group scores higher.
 */
describe('section-group representative', () => {
  const svc = () => new CitationAssemblyService({
    logger: { debug() {}, warn() {}, log() {}, error() {} } as any,
  });
  const chunk = (over: any) => ({
    docId: 'doc-x', documentId: 'doc-x', docTitle: '22_assessment_2krows.xlsx',
    section: '## 考核表', relevanceScore: 0, score: 0, ...over,
  });
  const inGroup = (...members: any[]) => members.map((c) => ({ ...c, sectionGroup: 'doc-x:0' }));
  const summary = chunk({
    id: 'c-summary', ord: 51, section: '## 汇总', relevanceScore: 0.95,
    context: '## 汇总\n| 锚点事实 | SUM-2026-5566 |',
    evidence: '## 汇总\n| 锚点事实 | SUM-2026-5566 |',
  });
  const detailHigh = chunk({
    id: 'c-detail-hi', ord: 50, relevanceScore: 0.70,
    context: '## 考核表 1996 | 考核项1996 | 90.1 |', evidence: '## 考核表 1996 | 考核项1996 | 90.1 |',
  });
  const detailLow = chunk({
    id: 'c-detail-lo', ord: 49, relevanceScore: 0.65,
    context: '## 考核表 1968 | 考核项1968 |', evidence: '## 考核表 1968 | 考核项1968 |',
  });

  it('emits the summary chunk for a summary-question regardless of group order', () => {
    for (const citations of [inGroup(detailHigh, detailLow, summary), inGroup(summary, detailHigh, detailLow)]) {
      const out = svc().selectEvidence(
        { citations },
        { breadth: false, tokenBudget: 4000, question: '考核汇总表的编号是多少？', subQueries: [] },
      );
      const ids = (out.citations || []).map((c: any) => String(c.id || ''));
      expect(ids[ids.length - 1]).toBe('c-summary');
    }
  });

  it('emits the best-scoring member when no summary is involved', () => {
    for (const citations of [inGroup(detailLow, detailHigh), inGroup(detailHigh, detailLow)]) {
      const out = svc().selectEvidence(
        { citations },
        { breadth: false, tokenBudget: 4000, question: '考核项1996 的得分是多少？', subQueries: [] },
      );
      const ids = (out.citations || []).map((c: any) => String(c.id || ''));
      expect(ids[ids.length - 1]).toBe('c-detail-hi');
    }
  });

  it('keeps the summary chunk reachable through sub-query injection', () => {
    const out = svc().selectEvidence(
      { citations: [
        { ...detailHigh, sectionGroup: 'doc-x:0', subQueryOrigin: '子问题A' },
        { ...detailLow, sectionGroup: 'doc-x:0', subQueryOrigin: '子问题A' },
        { ...summary, sectionGroup: 'doc-x:1', subQueryOrigin: '子问题B' },
      ] },
      {
        breadth: false, tokenBudget: 4000, subQueries: ['子问题A', '子问题B'],
        question: '考核汇总表的编号是多少？',
      },
    );
    expect((out.citations || []).map((c: any) => String(c.id || ''))).toContain('c-summary');
  });
});
