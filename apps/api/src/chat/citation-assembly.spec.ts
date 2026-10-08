import { CitationAssemblyService, mergeCitationsByDocument, stripMarkersOfDroppedCitations } from './citation-assembly';
import { buildContextualizedRerankText } from './fusion-rerank';
import { runWithRequestContext } from '../observability/request-context';

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
  const originalEnv = { ...process.env };
  beforeEach(() => {
    // The loosened floor set (0.22 ratio, guarantees, fill) is opt-in behind
    // RETRIEVAL_SOFT_FLOOR_ENABLED, default OFF (review P1-5).
    process.env.RETRIEVAL_SOFT_FLOOR_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
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

  it('boundary (P1-2): true answer at 0.15 under a 0.98 outlier survives ONLY via the guarantee', () => {
    // rawBest=0.98 with >=5 measured scores activates the smoothed baseline:
    // top3avg=(0.98+0.55+0.50)/3*1.1≈0.744 < 0.98*0.8=0.784 → baseline 0.784,
    // floor 0.784*0.22≈0.1725. The 0.15 true answer is BELOW the floor and can
    // only enter through a guaranteed slot.
    const candidates = [
      { id: 'outlier', topic: 'doc1', relevanceScore: 0.98, scoreSource: 'rerank', context: '长干扰内容' },
      { id: 'a', topic: 'doc2', relevanceScore: 0.55, scoreSource: 'rerank', context: 'text a' },
      { id: 'b', topic: 'doc3', relevanceScore: 0.50, scoreSource: 'rerank', context: 'text b' },
      { id: 'c', topic: 'doc4', relevanceScore: 0.45, scoreSource: 'rerank', context: 'text c' },
      { id: 'd', topic: 'doc5', relevanceScore: 0.40, scoreSource: 'rerank', context: 'text d' },
      { id: 'truth', topic: 'doc6', relevanceScore: 0.15, scoreSource: 'rerank', context: '真正的低分答案' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '边界问题',
    });
    expect(out.evidenceSelection.effectiveFloor).toBeGreaterThan(0.15);
    expect((out.citations || []).map((c: any) => c.id)).toContain('truth');
    // Contrast assertion required by the review: remove the guarantee
    // (RETRIEVAL_MIN_FLOOR_GROUPS=0) and the same answer is dropped by the
    // floor — this is what fails if the guarantee logic is deleted.
    process.env.RETRIEVAL_MIN_FLOOR_GROUPS = '0';
    const outNoGuarantee = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '边界问题',
    });
    expect((outNoGuarantee.citations || []).map((c: any) => c.id)).not.toContain('truth');
  });

  it('smoothing (P1-2): the smoothed baseline is observable and bounded at 80% of rawBest', () => {
    const candidates = [
      { id: 'outlier', topic: 'doc1', relevanceScore: 0.98, scoreSource: 'rerank', context: '长干扰内容' },
      { id: 'a', topic: 'doc2', relevanceScore: 0.55, scoreSource: 'rerank', context: 'text a' },
      { id: 'b', topic: 'doc3', relevanceScore: 0.50, scoreSource: 'rerank', context: 'text b' },
      { id: 'c', topic: 'doc4', relevanceScore: 0.45, scoreSource: 'rerank', context: 'text c' },
      { id: 'd', topic: 'doc5', relevanceScore: 0.40, scoreSource: 'rerank', context: 'text d' },
      { id: 'e', topic: 'doc6', relevanceScore: 0.20, scoreSource: 'rerank', context: 'text e' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '平滑验证',
    });
    // baseline = max(0.98*0.8, min(0.98, ((0.98+0.55+0.50)/3)*1.1)) = 0.784
    expect(out.evidenceSelection.effectiveFloor).toBeCloseTo(0.784 * 0.22, 5);
    // 0.20 clears the smoothed floor directly (0.98*0.22=0.2156 would cut it).
    expect((out.citations || []).map((c: any) => c.id)).toContain('e');
  });

  it('token budget (P1-3): an oversized group is skipped, not fatal — later short answers still enter', () => {
    // A high-scoring huge group would previously `break` the MMR loop and the
    // short factual group after it never reached the context.
    const big = '很长的制度正文'.repeat(900);      // ~6300 tokens
    const smallAnswer = '答案：补贴为每月300元。';  // ~12 tokens
    const candidates = [
      { id: 'warmup', topic: 'doc0', relevanceScore: 0.90, scoreSource: 'rerank', context: '普通长度开头段落'.repeat(10) },
      { id: 'huge', topic: 'doc1', relevanceScore: 0.85, scoreSource: 'rerank', context: big },
      { id: 'short-truth', topic: 'doc2', relevanceScore: 0.55, scoreSource: 'rerank', context: smallAnswer },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false,
      tokenBudget: 4000,
      question: '补贴标准是什么？',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('warmup');
    // The huge group exceeded what was left of the budget and was skipped
    // (degrading to its best member still did not fit), but the loop went on.
    expect(ids).not.toContain('huge');
    // The short true answer AFTER the oversized group is still selected —
    // this is the exact regression the review describes (P1-3).
    expect(ids).toContain('short-truth');
    expect(out.evidenceSelection.budgetSkippedGroups).toBeGreaterThanOrEqual(1);
  });

  it('token budget (P1-3): an oversized group degrades to its best member when that fits', () => {
    const big = '很长的制度正文'.repeat(200);       // ~1400 tokens
    const smallAnswer = '答案：补贴为每月300元。';
    const candidates = [
      { id: 'warmup', topic: 'doc0', relevanceScore: 0.90, scoreSource: 'rerank', context: '普通长度开头段落'.repeat(10) },
      { id: 'big-group', topic: 'doc1', relevanceScore: 0.85, scoreSource: 'rerank', context: big, sectionGroup: 'sec-1' },
      { id: 'big-group-tail', topic: 'doc1', relevanceScore: 0.60, scoreSource: 'rerank', context: big, sectionGroup: 'sec-1' },
      { id: 'short-truth', topic: 'doc2', relevanceScore: 0.55, scoreSource: 'rerank', context: smallAnswer },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false,
      tokenBudget: 1500,
      question: '补贴标准是什么？',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    // Whole sec-1 (~2800 tokens) cannot fit into the ~1500 budget, but one
    // member (~1400 with the warmup) does: the group is degraded, not dropped.
    expect(ids).toContain('big-group');
    expect(ids).not.toContain('big-group-tail');
    expect(ids).toContain('short-truth');
    expect(out.evidenceSelection.budgetDegradedGroups).toBeGreaterThanOrEqual(1);
  });
});

describe('selectEvidence floorMode trace (P0-1: adaptive without calibration must be observable)', () => {
  const svc = new CitationAssemblyService({
    logger: { debug: () => undefined, warn: () => undefined, log: () => undefined } as any,
  });

  it('reports floorMode=relative for raw measured scores without a calibration profile', () => {
    const out = svc.selectEvidence({
      citations: [
        { id: 'a', topic: 'doc1', relevanceScore: 0.8, context: 'text a' },
        { id: 'b', topic: 'doc2', relevanceScore: 0.5, context: 'text b' },
      ],
      reranked: true,
    }, { breadth: false, tokenBudget: 4000, question: '测试' });
    expect(out.evidenceSelection.floorMode).toBe('relative');
  });

  it('reports floorMode=uncalibrated in adaptive mode when no calibration profile exists', () => {
    // ADAPTIVE_RETRIEVAL_ENABLED=true without RERANK_CALIBRATION_FILE means
    // calibrateRerankScore always returns null, so no citation carries a
    // calibratedProbability. The floor then only exists as a ratio over
    // normalised (synthetic) scores — the trace must say so.
    runWithRequestContext({ requestId: 'floor-mode', execution: { adaptive: true } as any }, () => {
      const out = svc.selectEvidence({
        citations: [
          { id: 'a', topic: 'doc1', relevanceScore: 0.8, rerankScore: 0.8, context: 'text a' },
          { id: 'b', topic: 'doc2', relevanceScore: 0.5, rerankScore: 0.5, context: 'text b' },
        ],
        reranked: true,
      }, { breadth: false, tokenBudget: 4000, question: '测试' });
      expect(out.evidenceSelection.floorMode).toBe('uncalibrated');
    });
  });

  it('reports floorMode=calibrated in adaptive mode when calibrated probabilities exist', () => {
    runWithRequestContext({ requestId: 'floor-mode-2', execution: { adaptive: true } as any }, () => {
      const out = svc.selectEvidence({
        citations: [
          { id: 'a', topic: 'doc1', relevanceScore: 0.8, calibratedProbability: 0.71, context: 'text a' },
          { id: 'b', topic: 'doc2', relevanceScore: 0.5, calibratedProbability: 0.40, context: 'text b' },
        ],
        reranked: true,
      }, { breadth: false, tokenBudget: 4000, question: '测试' });
      expect(out.evidenceSelection.floorMode).toBe('calibrated');
    });
  });
});

describe('quality-first uncalibrated evidence selection', () => {
  const svc = new CitationAssemblyService({ logger: { debug: jest.fn(), warn: jest.fn() } as any });
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it.each([true, false])('keeps low raw-score answer passages for grounding (adaptive=%s)', (adaptive) => {
    process.env.RETRIEVAL_RELEVANCE_FLOOR_RATIO = '0.2';
    process.env.RETRIEVAL_MAX_GROUPS = '8';
    runWithRequestContext({ requestId: 'rank-selection', execution: { adaptive, qualityFirst: true } as any }, () => {
      const out = svc.selectEvidence({ reranked: true, citations: [
        { id: 'intro', docId: 'doc', scoreSource: 'rerank', relevanceScore: .92, context: 'The regulation describes measurement.' },
        { id: 'categories', docId: 'doc', scoreSource: 'rerank', relevanceScore: .004, context: 'Measurements comprise length, mass, and time.' },
        { id: 'boundary', docId: 'doc', scoreSource: 'rerank', relevanceScore: 0, context: 'This applies only to laboratory samples.' },
      ] }, { breadth: false, tokenBudget: 4000, question: 'What does measurement comprise?' });
      expect(out.citations.map((c: any) => c.id)).toEqual(expect.arrayContaining(['intro', 'categories', 'boundary']));
      expect(out.citations.every((c: any) => c.selectionReason === 'rank')).toBe(true);
      expect(out.evidenceSelection).toMatchObject({ floorMode: 'uncalibrated', calibrationAvailable: false,
        floorApplied: false, selectionScoreMode: 'rerank_ordinal', effectiveFloor: 0 });
      expect(out.evidenceSelection.eliminatedByStage.floor).toBeUndefined();
    });
  });

  it('does not let unscored placement scores displace ranked evidence or ignore the group limit', () => {
    process.env.RETRIEVAL_MAX_GROUPS = '2';
    process.env.RETRIEVAL_MULTISOURCE_COVERAGE_RATIO = '0';
    runWithRequestContext({ requestId: 'rank-cap', execution: { adaptive: true, qualityFirst: true } as any }, () => {
      const out = svc.selectEvidence({ reranked: true, citations: [
        { id: 'overflow', docId: 'overflow', rerankSkipped: true, scoreSource: 'synthetic', score: .99, context: 'Unmeasured.' },
        ...[.92, .004, .0001].map((score, i) => ({ id: `ranked-${i}`, docId: 'doc', relevanceScore: score,
          scoreSource: 'rerank', context: `Passage ${i}.` })),
      ] }, { breadth: false, tokenBudget: 4000 });
      expect(out.citations.map((c: any) => c.id)).toEqual(['ranked-0', 'ranked-1']);
      expect(out.evidenceSelection.eliminatedByStage).toMatchObject({ rerank_cap: 1, max_groups: 1 });
    });
  });

  it('keeps a calibrated floor active when a validated probability is available', () => {
    process.env.RETRIEVAL_SOFT_FLOOR_ENABLED = 'false';
    process.env.RETRIEVAL_RELEVANCE_FLOOR_RATIO = '0.2';
    runWithRequestContext({ requestId: 'calibrated-selection', execution: { adaptive: true, qualityFirst: true } as any }, () => {
      const out = svc.selectEvidence({ reranked: true, citations: [
        { id: 'supported', relevanceScore: .9, calibratedProbability: .9, scoreSource: 'rerank', context: 'Supported.' },
        { id: 'noise', relevanceScore: .001, calibratedProbability: .01, scoreSource: 'rerank', context: 'Noise.' },
      ] }, { breadth: false, tokenBudget: 4000 });
      expect(out.citations.map((c: any) => c.id)).toEqual(['supported']);
      expect(out.evidenceSelection).toMatchObject({ floorMode: 'calibrated', floorApplied: true });
    });
  });
});

describe('selectEvidence unified score contract (P0-2: no dimension mixing)', () => {
  const svc = new CitationAssemblyService({
    logger: { debug: () => undefined, warn: () => undefined, log: () => undefined } as any,
  });
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.RETRIEVAL_SOFT_FLOOR_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rerank-cap overflow candidates never take guaranteed slots or MMR rank from measured evidence', () => {
    // Pool shape from the review: 3 genuinely cross-encoded candidates (raw
    // rerank scores, best 0.42) plus 8 candidates the cross-encoder never saw
    // (rerankSkipped, still carrying fabricated 0.70-0.95 arm scores).
    const measured = [
      { id: 'm1', topic: '考勤制度V2', relevanceScore: 0.42, scoreSource: 'rerank', context: '迟到三十分钟以内扣款规则正文' },
      { id: 'm2', topic: '考勤制度V1', relevanceScore: 0.33, scoreSource: 'rerank', context: '旧版考勤制度的对应条款' },
      { id: 'm3', topic: '考勤细则', relevanceScore: 0.21, scoreSource: 'rerank', context: '实施细则中的补充规定' },
    ];
    const overflow = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      topic: `未重排候选${i}`,
      relevanceScore: 0.95 - i * 0.03,
      scoreSource: 'synthetic',
      rerankSkipped: true,
      context: `从未经过交叉编码器的候选正文 ${i}`,
    }));
    const out = svc.selectEvidence({ citations: [...measured, ...overflow], reranked: true }, {
      breadth: false,
      tokenBudget: 8000,
      question: '迟到怎么处理？',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    // Every measured candidate survives: the floor is anchored on the measured
    // scale (0.42*0.22 ≈ 0.09), not dragged by the synthetic 0.95s.
    for (const m of measured) expect(ids).toContain(m.id);
    // Synthetic overflow fills at most RETRIEVAL_SYNTHETIC_FILL_MAX (default 2)
    // leftover slots, in recall-ordinal order, and never displaces measured
    // evidence. Under the pre-contract code all 6 guaranteed slots went to the
    // normalised-to-~1 synthetic candidates.
    const overflowSelected = ids.filter((id: string) => id.startsWith('s'));
    expect(overflowSelected.length).toBeLessThanOrEqual(2);
    expect(out.evidenceSelection.floorMode).toBe('relative');
    expect(out.evidenceSelection.guaranteedGroups).toBe(3);
    // Fill order follows recall ordinal: s0 before s1.
    if (overflowSelected.length === 2) {
      expect(ids.indexOf('s0')).toBeLessThan(ids.indexOf('s1'));
    }
  });

  it('relative mode keeps the legacy ratio floor for synthetic-only pools', () => {
    // No measured score anywhere: the contract falls back to the legacy
    // relative floor over normalised scores, preserving pre-contract behavior.
    const candidates = [
      { id: 'c1', topic: 'doc1', score: 0.95, scoreSource: 'synthetic', context: 'text 1' },
      { id: 'c2', topic: 'doc2', score: 0.60, scoreSource: 'synthetic', context: 'text 2' },
      { id: 'c3', topic: 'doc3', score: 0.30, scoreSource: 'synthetic', context: 'text 3' },
      { id: 'c4', topic: 'doc4', score: 0.03, scoreSource: 'synthetic', context: 'text 4' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: false }, {
      breadth: false,
      tokenBudget: 8000,
      question: '测试查询',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('c1');
    expect(ids).toContain('c2');
    expect(ids).toContain('c3');
    expect(ids).not.toContain('c4');
    expect(out.evidenceSelection.floorMode).toBe('relative');
  });

  it('adaptive mode without calibration ranks the synthetic pool relatively (P0-1/P0-2 interplay)', () => {
    runWithRequestContext({ requestId: 'p0-2-adaptive', execution: { adaptive: true } as any }, () => {
      const candidates = [
        { id: 'a1', topic: 'doc1', relevanceScore: 0.9, rerankScore: 0.9, scoreSource: 'rerank', context: 'text a' },
        { id: 'a2', topic: 'doc2', relevanceScore: 0.4, rerankScore: 0.4, scoreSource: 'rerank', context: 'text b' },
      ];
      const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
        breadth: false, tokenBudget: 4000, question: '测试',
      });
      // Without a calibration profile these rerank scores are NOT measurements
      // in adaptive mode: the whole pool is synthetic-scale, floor is relative.
      expect(out.evidenceSelection.floorMode).toBe('uncalibrated');
      expect(out.evidenceSelection.syntheticFilled).toBeUndefined();
    });
  });

  it('floorExempt multi-hop bridge members stay eligible regardless of pool', () => {
    const candidates = [
      { id: 'm1', topic: 'doc1', relevanceScore: 0.80, scoreSource: 'rerank', context: 'primary evidence' },
      { id: 'bridge', topic: 'doc2', score: 0.30, scoreSource: 'synthetic', floorExempt: true, floorExemptReason: 'multi_hop_bridge', context: 'bridge evidence' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 4000, question: '测试',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('m1');
    expect(ids).toContain('bridge');
  });

  it('RETRIEVAL_SOFT_FLOOR_ENABLED=false (default) restores the rigid 0.35 floor without guarantees', () => {
    // Opt-out rollback path: without the flag the loosened set is inert. The
    // rigid floor cuts mid-relevance groups again and no guaranteed slots
    // exist — the pre-27cd327 semantics instances keep until the A/B gate.
    delete process.env.RETRIEVAL_SOFT_FLOOR_ENABLED;
    delete process.env.RETRIEVAL_RELEVANCE_FLOOR_RATIO;
    const candidates = [
      { id: 'top', topic: 'doc1', relevanceScore: 0.92, scoreSource: 'rerank', context: 'text 1' },
      { id: 'mid', topic: 'doc2', relevanceScore: 0.28, scoreSource: 'rerank', context: 'text 2' },
      { id: 'low', topic: 'doc3', relevanceScore: 0.03, scoreSource: 'rerank', context: 'text 3' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '测试查询',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('top');
    // 0.28 < 0.92*0.35 = 0.322 and no guarantee protects it anymore.
    expect(ids).not.toContain('mid');
    expect(ids).not.toContain('low');
    expect(out.evidenceSelection.guaranteedGroups).toBe(0);
    expect(out.evidenceSelection.relevanceFloorRatio).toBe(0.35);
    // Contrast assertion: with the flag on, the same mid candidate survives via
    // the guarantee (this is what fails if the guarantee logic is removed).
    process.env.RETRIEVAL_SOFT_FLOOR_ENABLED = 'true';
    const outOn = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '测试查询',
    });
    expect((outOn.citations || []).map((c: any) => c.id)).toContain('mid');
  });
  it('noise injection (P1-1): a 0.13-score novel-doc table chunk must not displace a 0.50-score same-doc text chunk', () => {
    // 9 groups compete for 8 slots. The noise chunk clears the softened floor
    // (0.55*0.22=0.121) and, under the OLD additive MMR, scored
    // 0.72*0.13+0.15(novel)+0.15(concrete)+0.10(table) ≈ 0.49 — above the
    // 0.50-score text chunk (0.72*0.50 ≈ 0.36 minus redundancy against the
    // same document's best chunk). Multiplicative boosts keep it below.
    const groups = [
      { id: 'best', docId: 'd1', relevanceScore: 0.55, scoreSource: 'rerank', context: '考勤管理制度总则与适用范围说明' },
      { id: 'real-text', docId: 'd1', relevanceScore: 0.50, scoreSource: 'rerank', context: '考勤管理制度 迟到处理标准条款正文' },
      { id: 'noise-table', docId: 'd2', relevanceScore: 0.13, scoreSource: 'rerank', docTitle: '附表.xlsx', context: '| 列一 | 列二 |\n| a | b |' },
      { id: 'g3', docId: 'd3', relevanceScore: 0.45, scoreSource: 'rerank', context: '第三份文档内容 alpha' },
      { id: 'g4', docId: 'd4', relevanceScore: 0.40, scoreSource: 'rerank', context: '第四份文档内容 beta' },
      { id: 'g5', docId: 'd5', relevanceScore: 0.35, scoreSource: 'rerank', context: '第五份文档内容 gamma' },
      { id: 'g6', docId: 'd6', relevanceScore: 0.30, scoreSource: 'rerank', context: '第六份文档内容 delta' },
      { id: 'g7', docId: 'd7', relevanceScore: 0.25, scoreSource: 'rerank', context: '第七份文档内容 epsilon' },
      { id: 'g8', docId: 'd8', relevanceScore: 0.24, scoreSource: 'rerank', context: '第八份文档内容 zeta' },
    ];
    const out = svc.selectEvidence({ citations: groups, reranked: true }, {
      breadth: false, tokenBudget: 20000, question: '迟到怎么处理？',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('best');
    expect(ids).toContain('real-text');   // same-doc mid-score evidence survives
    expect(ids).not.toContain('noise-table'); // fixed-boost noise must not win a slot
  });
});

describe('selectEvidence elimination funnel and selection reasons (review §4.1/§6)', () => {
  const svc = new CitationAssemblyService({
    logger: { debug: () => undefined, warn: () => undefined, log: () => undefined } as any,
  });
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.RETRIEVAL_SOFT_FLOOR_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('attributes every dropped candidate to rerank_cap / floor / max_groups with id-only records', () => {
    const candidates = [
      { id: 'm1', docId: 'd1', relevanceScore: 0.90, scoreSource: 'rerank', context: '高位证据' },
      { id: 'm2', docId: 'd2', relevanceScore: 0.70, scoreSource: 'rerank', context: '中位证据' },
      { id: 'below-floor', docId: 'd3', relevanceScore: 0.05, scoreSource: 'rerank', context: '低于地板' },
      { id: 'cap-1', docId: 'd4', relevanceScore: 0.9, scoreSource: 'synthetic', rerankSkipped: true, context: '超容量候选一' },
      { id: 'cap-2', docId: 'd5', relevanceScore: 0.9, scoreSource: 'synthetic', rerankSkipped: true, context: '超容量候选二' },
      { id: 'cap-3', docId: 'd6', relevanceScore: 0.9, scoreSource: 'synthetic', rerankSkipped: true, context: '超容量候选三' },
      { id: 'cap-4', docId: 'd7', relevanceScore: 0.9, scoreSource: 'synthetic', rerankSkipped: true, context: '超容量候选四' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '测试',
    });
    const byStage = out.evidenceSelection.eliminatedByStage;
    expect(byStage.floor).toBe(1);          // below-floor measured candidate
    // 4 overflow candidates: 2 fill leftover slots, the other 2 are attributed
    // to the rerank capacity stage.
    expect(byStage.rerank_cap).toBe(2);
    // The eliminated records carry identity + stage, never text.
    for (const record of out.evidenceSelection.eliminated) {
      expect(Object.keys(record).sort()).toEqual(['chunkId', 'docId', 'ordinal', 'scoreSource', 'stage'].sort());
    }
    // Funnel numbers for the trace UI.
    expect(out.evidenceSelection.funnel).toEqual({
      recalled: 7,
      rerankScored: 3,
      eligible: 2,
      selected: 4,
    });
  });

  it('marks each selected citation with an audit selectionReason', () => {
    const candidates = [
      { id: 'top', docId: 'd1', relevanceScore: 0.9, scoreSource: 'rerank', context: '通过地板的高分证据' },
      { id: 'saved', docId: 'd2', relevanceScore: 0.13, scoreSource: 'rerank', context: '靠保底入选的低分证据' },
      { id: 'exempt', docId: 'd3', score: 0.2, scoreSource: 'synthetic', floorExempt: true, context: '多跳豁免证据' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '测试',
    });
    const reasons = Object.fromEntries((out.citations || []).map((c: any) => [c.id, c.selectionReason]));
    expect(reasons.top).toBe('floor');
    expect(reasons.saved).toBe('guaranteed');
    expect(reasons.exempt).toBe('exempt');
  });

  it('multi-source coverage (§3.3): a same-topic document keeps its best member instead of being monopolised out', () => {
    // Attendance-V2 shape: two sibling policies on the same topic are both in
    // the pool; with tight context slots the dominant document takes every
    // slot and the sibling never reaches the context. The coverage constraint
    // guarantees the sibling's best member a slot.
    process.env.RETRIEVAL_MAX_GROUPS = '2';
    const candidates = [
      { id: 'v2-a', docId: 'doc-v2', relevanceScore: 0.90, scoreSource: 'rerank', context: '考勤管理制度 迟到一次警告 迟到两次扣款 处理规定' },
      { id: 'v2-b', docId: 'doc-v2', relevanceScore: 0.80, scoreSource: 'rerank', context: '考勤管理制度 上下班时间规定 弹性工作制说明' },
      { id: 'v1-a', docId: 'doc-v1', relevanceScore: 0.50, scoreSource: 'rerank', context: '考勤管理制度旧版 迟到处理规定 扣款标准说明' },
      { id: 'noise', docId: 'doc-x', relevanceScore: 0.30, scoreSource: 'rerank', context: '完全无关的报销制度内容 差旅发票' },
    ];
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '迟到怎么处理？',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    // The dominant doc takes the two regular slots…
    expect(ids).toContain('v2-a');
    expect(ids).toContain('v2-b');
    // …but doc-v1 scores 0.50 ≥ 0.35×0.90 and is topically close to the
    // selected attendance evidence → its best member is guaranteed a slot.
    expect(ids).toContain('v1-a');
    expect((out.citations || []).find((c: any) => c.id === 'v1-a').selectionReason).toBe('multi_source');
    // The unrelated doc does not get the coverage slot.
    expect(ids).not.toContain('noise');
    expect(out.evidenceSelection.multiSourceAdded).toBeGreaterThanOrEqual(1);
  });

  it('multi-source coverage also protects with the soft-floor flag OFF (P3-02 regression)', () => {
    // The P3-02 release-gate failure: in relative mode (adaptive without
    // calibration) a qualifying sibling policy lost its slot to same-document
    // bulk under purely multiplicative boosts, and every protection was behind
    // the OFF-by-default soft-floor flag. Coverage must protect regardless.
    delete process.env.RETRIEVAL_SOFT_FLOOR_ENABLED;
    delete process.env.RETRIEVAL_MULTISOURCE_COVERAGE_RATIO;
    const candidates = [
      { id: 'v3-a', docId: 'doc-v3', relevanceScore: 0.90, scoreSource: 'rerank', context: '考勤管理制度 弹性打卡时间 09:00 至 10:00 规定' },
      { id: 'v3-b', docId: 'doc-v3', relevanceScore: 0.85, scoreSource: 'rerank', context: '考勤管理制度 迟到处罚条款 迟到扣款标准' },
      { id: 'manual-a', docId: 'doc-manual', relevanceScore: 0.80, scoreSource: 'rerank', context: '考勤管理制度详细手册 夏令时作息时间说明' },
      { id: 'v2-truth', docId: 'doc-v2', relevanceScore: 0.45, scoreSource: 'rerank', context: '考勤制度手册V2 固定打卡时间 09:00 规定' },
    ];
    process.env.RETRIEVAL_MAX_GROUPS = '3';
    const out = svc.selectEvidence({ citations: candidates, reranked: true }, {
      breadth: false, tokenBudget: 8000, question: '员工考勤的时间是什么',
    });
    const ids = (out.citations || []).map((c: any) => c.id);
    expect(ids).toContain('v3-a');
    expect(ids).toContain('v2-truth');
    expect((out.citations || []).find((c: any) => c.id === 'v2-truth').selectionReason).toBe('multi_source');
    expect(out.evidenceSelection.multiSourceAdded).toBeGreaterThanOrEqual(1);
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

  it('prefers the fullest text field over a truncated snippet preview (review P2)', () => {
    const text = buildContextualizedRerankText({
      docTitle: '制度.pdf',
      evidence: '完整的条款正文内容，包含全部细节描述，不会被截断。',
      snippet: '完整的条款…',
    });
    expect(text).toContain('包含全部细节描述');
    expect(text).not.toContain('…');
  });

  it('filters placeholder breadcrumbs like 文档正文 out of the hierarchy', () => {
    const text = buildContextualizedRerankText({
      docTitle: '无结构文档.md',
      breadcrumb: '文档正文',
      context: '正文内容',
    });
    expect(text).toBe('无结构文档.md\n正文内容');
  });

  it('uses headingHierarchy (either naming) as the richest structural trail', () => {
    const camel = buildContextualizedRerankText({
      docTitle: '财务制度.pdf',
      headingHierarchy: ['财务制度', '费用报销'],
      context: '报销需提供发票。',
    });
    expect(camel).toContain('财务制度 > 费用报销');
    const snake = buildContextualizedRerankText({
      docTitle: '财务制度.pdf',
      heading_hierarchy: ['财务制度', '费用报销'],
      context: '报销需提供发票。',
    });
    expect(snake).toContain('财务制度 > 费用报销');
  });

  it('does not repeat an article number already baked into the evidence text', () => {
    const text = buildContextualizedRerankText({
      docTitle: '考勤制度.pdf',
      articleNo: '第十二条',
      evidence: '【第十二条】迟到处理标准如下。',
    });
    expect(text.match(/第十二条/g)).toHaveLength(1);
  });
});


describe('aggregate document permission boundary', () => {
  const guard = { scopeId: 'scope', sourceKeys: [], aclEpoch: 1, knowledgeEpoch: 1, userId: 'user' };
  it('rejects restricted empty-ACL sources and never leaves their text in answer', async () => {
    const filterReadableDocuments = jest.fn().mockResolvedValue(new Set());
    const service = new CitationAssemblyService({ logger: { warn: jest.fn() } as any,
      prisma: { document: { findMany: jest.fn().mockResolvedValue([{ id: 'secret', kbId: 'kb', aclMode: 'restricted' }]) } },
      documentAclService: { filterReadableDocuments } as any });
    const result = await service.filterQueryResultByCurrentPermission({ citations: [{ kbId: 'kb', raptor: true,
      sourceDocumentIds: ['secret'], context: 'FORBIDDEN_MARKER' }] }, ['kb'], guard);
    expect(filterReadableDocuments).toHaveBeenCalledWith('user', ['secret'], expect.objectContaining({ docs: [expect.objectContaining({ aclMode: 'restricted' })] }));
    expect(result.citations).toEqual([]);
    expect(result.answer).not.toContain('FORBIDDEN_MARKER');
  });
  it('preserves exact source manifest for a readable aggregate', async () => {
    const service = new CitationAssemblyService({ logger: {} as any,
      prisma: { document: { findMany: jest.fn().mockResolvedValue([{ id: 'source', kbId: 'kb', version: 2, activeVersionId: 'v2', contentHash: 'hash' }]) } },
      documentAclService: { filterReadableDocuments: jest.fn().mockResolvedValue(new Set(['source'])) } as any });
    const result = await service.filterQueryResultByCurrentPermission({ citations: [{ kbId: 'kb', raptor: true,
      sourceDocumentIds: ['source'], context: 'readable' }] }, ['kb'], guard);
    expect(result.citations[0].sourceManifest).toEqual([{ docId: 'source', version: 2, documentVersionId: 'v2', sourceHash: 'hash' }]);
  });
});

describe('request entailment memo', () => {
  it('reuses each statement only for the same evidence, source manifest and model', async () => {
    const config = { modelName: 'judge-v1', baseUrl: 'http://judge' };
    const service = new CitationAssemblyService({ logger: {} as any, modelConfigService: {
      getFastLlmChatConfig: jest.fn().mockImplementation(async () => config),
    } as any });
    const execute = jest.spyOn(service as any, 'executeEntailmentBatch').mockResolvedValue(new Set([0]));
    await runWithRequestContext({ requestId: 'memo', evidenceDependencies: [{ documentId: 'doc', versionId: 'v1', number: 1, sourceHash: 'h', effectiveTo: null }] }, async () => {
      await service.judgeEntailment(['statement'], 'x'.repeat(6001) + 'tail support');
      await service.judgeEntailment(['statement'], 'x'.repeat(6001) + 'tail support');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][1]).toContain('tail support');
      await service.judgeEntailment(['statement'], 'different evidence');
      expect(execute).toHaveBeenCalledTimes(2);
      config.modelName = 'judge-v2';
      await service.judgeEntailment(['statement'], 'different evidence');
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });
  it('does not retain a failed judge result', async () => {
    const service = new CitationAssemblyService({ logger: {} as any, modelConfigService: {
      getFastLlmChatConfig: jest.fn().mockResolvedValue({ modelName: 'judge', baseUrl: 'http://judge' }),
    } as any });
    const execute = jest.spyOn(service as any, 'executeEntailmentBatch').mockResolvedValueOnce(null).mockResolvedValue(new Set([0]));
    await runWithRequestContext({ requestId: 'retry' }, async () => {
      await expect(service.judgeEntailment(['statement'], 'evidence')).resolves.toEqual(new Set([0]));
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });
});

describe('cross-KB aggregate context', () => {
  it('drops a mismatched inventory before its forbidden marker reaches the model context', async () => {
    const service = new CitationAssemblyService({ logger: {} as any,
      prisma: { document: { findMany: jest.fn().mockResolvedValue([{ id: 'doc-b', kbId: 'kb-b' }]) } },
      documentAclService: { filterReadableDocuments: jest.fn().mockResolvedValue(new Set(['doc-b'])) } as any });
    const authorized = await service.filterQueryResultByCurrentPermission({ citations: [{ kbId: 'kb-a', inventory: true,
      sourceDocumentIds: ['doc-b'], context: 'FORBIDDEN_CROSS_KB_MARKER' }] }, ['kb-a', 'kb-b'],
      { scopeId: 'scope', sourceKeys: [], aclEpoch: 1, knowledgeEpoch: 1, userId: 'user' });
    expect(JSON.stringify(authorized)).not.toContain('FORBIDDEN_CROSS_KB_MARKER');
    expect(authorized.citations).toEqual([]);
  });
});

describe('aggregate version snapshot', () => {
  it('does not relabel a retrieved summary after a source version switch', async () => {
    const service = new CitationAssemblyService({ logger: {} as any,
      prisma: { document: { findMany: jest.fn().mockResolvedValue([{ id: 'doc', kbId: 'kb', version: 2,
        activeVersionId: 'new-version', contentHash: 'new-hash' }]) } },
      documentAclService: { filterReadableDocuments: jest.fn().mockResolvedValue(new Set(['doc'])) } as any });
    const result = await service.filterQueryResultByCurrentPermission({ citations: [{ kbId: 'kb', raptor: true,
      sourceDocumentIds: ['doc'], sourceManifest: [{ docId: 'doc', version: 1, documentVersionId: 'old-version', sourceHash: 'old-hash' }],
      context: 'OBSOLETE_SUMMARY_MARKER' }] }, ['kb'], { scopeId: 'scope', sourceKeys: [], aclEpoch: 1, knowledgeEpoch: 1, userId: 'user' });
    expect(result.citations).toEqual([]);
    expect(result.answer).not.toContain('OBSOLETE_SUMMARY_MARKER');
  });
});
