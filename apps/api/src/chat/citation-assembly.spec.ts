import { CitationAssemblyService, mergeCitationsByDocument, stripMarkersOfDroppedCitations } from './citation-assembly';
import { buildContextualizedRerankText } from './fusion-rerank';

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

describe('selectEvidence dynamic soft floor and guaranteed top groups', () => {
  const svc = new CitationAssemblyService({
    logger: { debug: () => undefined, warn: () => undefined, log: () => undefined } as any,
  });

  it('protects valid 0.25 answers from being eliminated when single outlier scores 0.98', () => {
    const result = {
      citations: [
        { id: 'outlier-1', topic: '干扰长文', relevanceScore: 0.98, context: '包含大量问题词汇但无结论' },
        { id: 'valid-ans', topic: '简要规范', relevanceScore: 0.25, context: '核心指标规定为300元每人每月' },
        { id: 'distractor-low', topic: '无关内容', relevanceScore: 0.04, context: '完全无关内容' },
      ],
      reranked: true,
    };
    const out = svc.selectEvidence(result, {
      breadth: false,
      tokenBudget: 4000,
      question: '特种作业补贴发放标准是多少？',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('outlier-1');
    expect(ids).toContain('valid-ans'); // 0.25 answer protected by dynamic soft floor and top groups
    expect(ids).not.toContain('distractor-low'); // < 0.10 low-score distractor correctly pruned
  });

  it('preserves top M candidate groups under high candidate density', () => {
    const candidates = [
      { id: 'c1', topic: 'doc1', relevanceScore: 0.92, context: 'text 1' },
      { id: 'c2', topic: 'doc2', relevanceScore: 0.85, context: 'text 2' },
      { id: 'c3', topic: 'doc3', relevanceScore: 0.70, context: 'text 3' },
      { id: 'c4', topic: 'doc4', relevanceScore: 0.50, context: 'text 4' },
      { id: 'c5', topic: 'doc5', relevanceScore: 0.28, context: 'text 5' },
      { id: 'c6', topic: 'doc6', relevanceScore: 0.22, context: 'text 6' },
      { id: 'c7', topic: 'doc7', relevanceScore: 0.03, context: 'text 7' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false,
      tokenBudget: 8000,
      question: '测试查询',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('c5'); // 0.28 protected
    expect(ids).toContain('c6'); // 0.22 protected
    expect(ids).not.toContain('c7'); // 0.03 pruned
  });
});

describe('buildContextualizedRerankText', () => {
  it('prepends document title and breadcrumb/section hierarchy to chunk text', () => {
    const text = buildContextualizedRerankText({
      docTitle: '员工考勤管理制度.pdf',
      breadcrumb: '第四章 请假管理',
      articleNo: '第十二条',
      context: '病假应提供二级甲等及以上医院开具的诊断证明。',
    });
    expect(text).toContain('员工考勤管理制度.pdf');
    expect(text).toContain('第四章 请假管理 > 第十二条');
    expect(text).toContain('病假应提供二级甲等及以上医院开具的诊断证明。');
  });

  it('falls back cleanly when hierarchy metadata is missing', () => {
    const text = buildContextualizedRerankText({
      docTitle: '通用文档.pdf',
      context: '正文内容第一行',
    });
    expect(text).toBe('通用文档.pdf\n正文内容第一行');
  });
});

