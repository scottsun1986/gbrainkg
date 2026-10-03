import { mergeCitationsByDocument, stripMarkersOfDroppedCitations } from './citation-assembly';

describe('mergeCitationsByDocument', () => {
  const chunk = (over: Record<string, any>) => ({
    kbId: 'kb-1', docId: 'doc-1', docTitle: '员工手册.pdf', context: '', score: 0.5,
    ...over,
  });

  it('merges chunks of the same document into one entry preserving order', () => {
    const merged = mergeCitationsByDocument([
      chunk({ docId: 'doc-a', context: '第一段', section: '第一章' }),
      chunk({ docId: 'doc-b', docTitle: 'B文档', context: 'B 的内容' }),
      chunk({ docId: 'doc-a', context: '第二段', section: '第二章', score: 0.9 }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].docId).toBe('doc-a');
    expect(merged[0].mergedChunkCount).toBe(2);
    // first-occurrence order kept: doc-a first, doc-b second
    expect(merged[1].docId).toBe('doc-b');
    // both chunk texts kept with the section anchor between them
    expect(merged[0].context).toContain('第一段');
    expect(merged[0].context).toContain('【第二章】');
    expect(merged[0].context).toContain('第二段');
    // best score wins
    expect(merged[0].score).toBe(0.9);
  });

  it('does not merge documents sharing a title across knowledge bases', () => {
    const merged = mergeCitationsByDocument([
      chunk({ kbId: 'kb-1', docId: 'doc-a', context: 'KB1 内容' }),
      chunk({ kbId: 'kb-2', docId: 'doc-a', context: 'KB2 内容' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('falls back to title keying for sources without doc ids', () => {
    const merged = mergeCitationsByDocument([
      chunk({ docId: undefined, docTitle: '同名文档', context: '甲库' }),
      chunk({ docId: undefined, docTitle: '同名文档', context: '同库第二段' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].context).toContain('同库第二段');
  });

  it('ignores an exact-duplicate chunk instead of duplicating text', () => {
    const merged = mergeCitationsByDocument([
      chunk({ context: '重复内容' }),
      chunk({ context: '重复内容' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].context.match(/重复内容/g)).toHaveLength(1);
  });

  it('keeps singletons untouched (no merge metadata needed)', () => {
    const merged = mergeCitationsByDocument([chunk({ docId: 'solo', context: '唯一' })]);
    expect(merged).toHaveLength(1);
    // single-element input short-circuits: absent mergedChunkCount reads as 1
    expect(merged[0].mergedChunkCount ?? 1).toBe(1);
    expect(merged[0].context).toBe('唯一');
  });

  it('ORs compiled-truth flags across merged chunks', () => {
    const merged = mergeCitationsByDocument([
      chunk({ docId: 'doc-a', context: 'a' }),
      chunk({ docId: 'doc-a', context: 'b', isCompiledTruth: true, isCompiledDerived: true }),
    ]);
    expect(merged[0].isCompiledTruth).toBe(true);
    expect(merged[0].isCompiledDerived).toBe(true);
  });
});

describe('stripMarkersOfDroppedCitations (ACL strip marker hygiene)', () => {
  it('keeps surviving markers by ORIGINAL index when a middle citation is ACL-dropped', () => {
    // citations [1,2,3]; [2] failed the independent ACL check → survivors {1,3}
    const answer = stripMarkersOfDroppedCitations(
      '结论甲[1]。结论乙[2]。结论丙[3]。',
      new Set([1, 3]),
    );
    expect(answer).toBe('结论甲[1]。结论乙。结论丙[3]。');
  });

  it('keeps the last marker when all earlier citations are dropped', () => {
    const answer = stripMarkersOfDroppedCitations('a[1] b[2] c[3]', new Set([3]));
    expect(answer).toBe('a b c[3]');
  });

  it('strips every marker when nothing survives', () => {
    expect(stripMarkersOfDroppedCitations('x[1] y[2]', new Set())).toBe('x y');
  });

  it('does not touch markers when the full set survives', () => {
    const original = '甲[1] 乙[2] 丙[3]';
    expect(stripMarkersOfDroppedCitations(original, new Set([1, 2, 3]))).toBe(original);
  });
});
