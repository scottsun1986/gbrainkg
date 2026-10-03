import { alignSiblingEditionChunks, normalizeFamilyTitle } from './version-sibling-evidence';

/**
 * Production: a "V1 vs V2" question cited V1's 能力/行为 sections while V2's
 * matching sections never reached the model. Alignment must pull the matching
 * section of the OTHER edition, not an arbitrary chunk of it.
 */
describe('sibling edition alignment', () => {
  it('normalizes edition markers out of the family title', () => {
    expect(normalizeFamilyTitle('员工考核制度V1.docx')).toBe('员工考核制度');
    expect(normalizeFamilyTitle('员工考核制度_v2.pdf')).toBe('员工考核制度');
    expect(normalizeFamilyTitle('员工考核制度（修订版）')).toBe('员工考核制度');
    expect(normalizeFamilyTitle('考勤管理办法 V2')).toBe(normalizeFamilyTitle('考勤管理办法'));
  });

  const v2Chunks = [
    { id: 'v2-0', documentId: 'v2', ord: 0, text: '第一章 总则 为规范公司管理制定本制度。' },
    { id: 'v2-11', documentId: 'v2', ord: 11, text: '能力考核：考核员工专业技能、学习能力与问题解决能力，占比40%。' },
    { id: 'v2-12', documentId: 'v2', ord: 12, text: '行为考核：考核员工工作态度、团队协作与纪律遵守情况，占比30%。' },
    { id: 'v2-20', documentId: 'v2', ord: 20, text: '附则 本制度自发布之日起施行。' },
  ];
  const families = new Map([['v1', ['v1', 'v2']]]);
  const chunksByDoc = new Map([['v2', v2Chunks]]);

  it('picks the counterpart section in the other edition for each cited chunk', () => {
    const anchors = [
      { documentId: 'v1', text: '能力考核：考核员工专业技能与学习能力，占比50%。' },
      { documentId: 'v1', text: '行为考核：考核员工工作态度与纪律遵守情况，占比20%。' },
    ];
    const out = alignSiblingEditionChunks(anchors, families, chunksByDoc, new Set(), {
      question: 'V1和V2的能力考核与行为考核有什么区别',
      max: 4,
    });
    expect(out.map((c) => c.id).sort()).toEqual(['v2-11', 'v2-12']);
    expect(out.every((c) => c.alignedFrom === 'v1')).toBe(true);
  });

  it('skips chunks that are already cited and respects the cap', () => {
    const anchors = [
      { documentId: 'v1', text: '能力考核：考核员工专业技能与学习能力。' },
      { documentId: 'v1', text: '行为考核：考核员工工作态度与纪律遵守。' },
    ];
    const out = alignSiblingEditionChunks(anchors, families, chunksByDoc, new Set(['v2-11']), {
      question: '能力考核',
      max: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('v2-12');
  });

  it('adds nothing when no sibling chunk is similar enough', () => {
    const anchors = [{ documentId: 'v1', text: '差旅报销标准：一线城市住宿每晚不超过500元。' }];
    const out = alignSiblingEditionChunks(anchors, families, chunksByDoc, new Set(), {
      question: '住宿报销标准',
      max: 4,
    });
    expect(out).toEqual([]);
  });

  it('ignores anchors from documents without a family', () => {
    const out = alignSiblingEditionChunks(
      [{ documentId: 'other', text: '能力考核：考核员工专业技能。' }],
      families,
      chunksByDoc,
      new Set(),
      { question: '能力考核', max: 4 },
    );
    expect(out).toEqual([]);
  });
});
