import {
  filterRescueHits,
  needsSectionRescue,
  pickRescueTargets,
  RescueChunk,
} from './section-rescue';

const detail: RescueChunk = {
  id: 'c1',
  documentId: 'doc-1',
  kbId: 'kb-1',
  ord: 1,
  content: '| 1227 | 考核项1227 | 82.3 |\n'.repeat(30),
  section: '考核表',
  breadcrumb: 'xlsx > 考核表',
  headingHierarchy: ['考核表'],
  tableRole: 'detail',
};

const summary: RescueChunk = {
  id: 'c2',
  documentId: 'doc-1',
  kbId: 'kb-1',
  ord: 99,
  content: '## 汇总\n| 锚点事实 | XLSX-KEY-汇总表编号SUM-2026-5566 |',
  section: '汇总',
  breadcrumb: 'xlsx > 汇总',
  headingHierarchy: ['汇总'],
  tableRole: 'summary',
};

describe('section-rescue', () => {
  it('flags rescue when summary section is missing', () => {
    expect(needsSectionRescue('考核汇总表的编号是多少？', [detail])).toBe(true);
    expect(needsSectionRescue('考核汇总表的编号是多少？', [detail, summary])).toBe(false);
  });

  it('does not rescue for unrelated questions', () => {
    expect(needsSectionRescue('今天天气怎么样', [detail])).toBe(false);
  });

  it('picks unique documents as rescue targets', () => {
    const targets = pickRescueTargets('汇总', [
      { documentId: 'doc-1', kbId: 'kb-1' },
      { documentId: 'doc-1', kbId: 'kb-1' },
      { documentId: 'doc-2', kbId: 'kb-1' },
    ]);
    expect(targets.map((t) => t.documentId)).toEqual(['doc-1', 'doc-2']);
  });

  it('accepts docId alias used by gbrain citations', () => {
    const targets = pickRescueTargets('汇总', [{ docId: 'doc-9', kbId: 'kb-1' } as any]);
    expect(targets.map((t) => t.documentId)).toEqual(['doc-9']);
  });

  it('keeps only structurally matching or summary hits', () => {
    const kept = filterRescueHits('考核汇总表的编号是多少？', [detail, summary]);
    expect(kept.map((h) => h.id)).toEqual(['c2']);
  });
});
