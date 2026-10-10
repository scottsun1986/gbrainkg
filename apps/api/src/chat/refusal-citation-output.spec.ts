import { CitationAssemblyService } from './citation-assembly';

/**
 * Regression (2026-10-10): a standard marker-less refusal
 * ("已知知识库资料中未包含相关信息，无法回答该问题。") still shipped up to 20
 * candidate citations — the identical-content expansion turned an 8-candidate
 * slice into duplicates, so the UI showed "引用 20 条" beside an answer that
 * explicitly says nothing was found. A refusal references no source; the
 * fast-refusal gate already passes [] (chat.service.ts), and these cases pin
 * that the synthesized / model-shaped marker-less refusals now do the same.
 * Refusals that deliberately walk through each checked source and cite it
 * (…[1][3]) keep those references.
 */
describe('marker-less refusal emits zero citations', () => {
  const logger = { debug: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined } as any;
  const trace = { start: jest.fn(), finish: jest.fn() } as any;

  const subscriber = { next: jest.fn(), complete: jest.fn() } as any;

  const citation = (over: Record<string, any> = {}) => ({
    docId: 'doc-1',
    documentId: 'doc-1',
    kbId: 'kb-1',
    docTitle: '员工手册.pdf',
    context: '第十条 员工每年享有带薪年假十天。',
    evidence: '第十条 员工每年享有带薪年假十天。',
    snippet: '第十条 员工每年享有带薪年假十天。',
    score: 0.9,
    ...over,
  });

  // Echo the queried ids back so the third-layer ACL check keeps every citation
  // (the mocked docs carry no contentHash, so identical-content expansion adds
  // nothing and the list stays exactly as emitCitationsAndComplete decided it).
  const prisma = {
    document: {
      findMany: jest.fn(async (args: any) => (args?.where?.id?.in ?? []).map((id: string) => ({ id }))),
    },
  } as any;
  const permissionService = {
    getVisibleKnowledgeBases: jest.fn(async () => ['kb-1']),
  } as any;
  const store = jest.fn().mockResolvedValue(undefined);

  const buildService = () => {
    const svc = new CitationAssemblyService({
      logger,
      prisma,
      permissionService,
      semanticCacheService: { store } as any,
    } as any);
    // Grounded non-refusal answers reach the entailment gate; a permissive judge
    // keeps the cache path exercised without an LLM dependency.
    jest.spyOn(svc, 'judgeEntailment').mockResolvedValue(new Set<number>([0]));
    return svc;
  };

  const citationEvents = () =>
    subscriber.next.mock.calls
      .map(([event]: any[]) => event?.data)
      .filter((data: any) => data?.type === 'citation');

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CACHE_ENTAILMENT_GATE;
  });

  it('emits ZERO citations for a marker-less standard refusal even with a large candidate pool', async () => {
    const svc = buildService();
    const pool = Array.from({ length: 20 }, (_, i) => citation({ docId: `doc-${i}`, context: `候选片段 ${i}` }));
    await svc.emitCitationsAndComplete(
      'user-1',
      pool,
      subscriber,
      0,
      '已知知识库资料中未包含相关信息，无法回答该问题。',
      trace,
      '某标准编号是多少？',
      undefined,
      undefined,
      'refusal',
    );
    expect(citationEvents()).toHaveLength(0);
    // And it is never cached.
    expect(store).not.toHaveBeenCalled();
  });

  it('covers the low-confidence refusal phrasing too', async () => {
    const svc = buildService();
    const pool = Array.from({ length: 12 }, (_, i) => citation({ docId: `doc-${i}`, context: `候选片段 ${i}` }));
    await svc.emitCitationsAndComplete(
      'user-1',
      pool,
      subscriber,
      0,
      '知识库中检索到了与该问题主题相关的资料，但其相关度置信度不足，为避免误导，本次无法回答。',
      trace,
      '某标准编号是多少？',
    );
    expect(citationEvents()).toHaveLength(0);
  });

  it('keeps the referenced sources when a refusal cites the documents it checked', async () => {
    const svc = buildService();
    const pool = [
      citation({ docId: 'doc-a', context: '来源 A 未记载该编号。' }),
      citation({ docId: 'doc-b', context: '来源 B 未记载该编号。' }),
      citation({ docId: 'doc-c', context: '来源 C 未记载该编号。' }),
    ];
    await svc.emitCitationsAndComplete(
      'user-1',
      pool,
      subscriber,
      0,
      '现有资料涉及管理规范和运维要求，均未记载问题要求的方案或编号[1]。',
      trace,
      '某编号是多少？',
    );
    const events = citationEvents();
    expect(events).toHaveLength(1);
    expect(events[0].index).toBe(1);
    expect(events[0].timeline_entry.document_id).toBe('doc-a');
  });

  it('keeps the 8-candidate cap for a marker-less NON-refusal answer (behavior unchanged)', async () => {
    const svc = buildService();
    const pool = Array.from({ length: 20 }, (_, i) => citation({
      docId: `doc-${i}`,
      context: `第十条 员工每年享有带薪年假十天。片段 ${i}`,
      evidence: `第十条 员工每年享有带薪年假十天。`,
    }));
    await svc.emitCitationsAndComplete('user-1', pool, subscriber, 0, '员工每年享有带薪年假十天。', trace, '年假是多少天？');
    const events = citationEvents();
    expect(events).toHaveLength(8);
    expect(events.map((e: any) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});