import { CitationAssemblyService } from './citation-assembly';

/**
 * The semantic cache replays one answer to every user in the same scope for the
 * whole TTL, so a fabricated statement that survives the lexical grounding
 * proxy would be re-served many times before anyone corrected it. These cases
 * pin the write-side entailment gate: the judge's rejection must veto the store,
 * and a judge that cannot answer must not be treated as approval.
 */
describe('pre-cache entailment gate', () => {
  const logger = { debug: () => undefined, warn: () => undefined, log: () => undefined, error: () => undefined } as any;

  const subscriber = { next: jest.fn(), complete: jest.fn() } as any;
  const trace = { start: jest.fn(), finish: jest.fn() } as any;

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

  const store = jest.fn().mockResolvedValue(undefined);

  // The third-layer ACL check runs before the cache gate, so the service needs
  // a permission lookup and a document query that both confirm the cited doc.
  const permissionService = {
    getVisibleKnowledgeBases: jest.fn(async () => ['kb-1']),
  } as any;
  const prisma = {
    document: { findMany: jest.fn(async () => [{ id: 'doc-1' }]) },
  } as any;

  const buildService = (judge: (statements: string[], evidence: string) => Promise<Set<number>>) => {
    const svc = new CitationAssemblyService({
      logger,
      prisma,
      permissionService,
      semanticCacheService: { store } as any,
    });
    jest.spyOn(svc, 'judgeEntailment').mockImplementation(judge as any);
    return svc;
  };

  // The answer must clear the lexical proxy first or the gate never runs; these
  // statements quote the cited evidence verbatim.
  const groundedAnswer = '员工每年享有带薪年假十天。';

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CACHE_ENTAILMENT_GATE;
  });

  it('caches when every statement is entailed by the cited evidence', async () => {
    const svc = buildService(async (statements) => new Set(statements.map((_, i) => i)));
    await svc.emitCitationsAndComplete('user-1', [citation()], subscriber, 0, groundedAnswer, trace, '年假是多少天？', {
      fingerprint: 'scope-1',
      knowledgeEpoch: 1,
    });
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('vetoes the write when the judge rejects a statement', async () => {
    // Reject everything: the answer is lexically supported but not entailed.
    const svc = buildService(async () => new Set<number>());
    await svc.emitCitationsAndComplete('user-1', [citation()], subscriber, 0, groundedAnswer, trace, '年假是多少天？', {
      fingerprint: 'scope-1',
      knowledgeEpoch: 1,
    });
    expect(store).not.toHaveBeenCalled();
  });

  it('vetoes the write when only some statements are entailed', async () => {
    const answer = '员工每年享有带薪年假十天。第十条 员工每年享有带薪年假十天。';
    const svc = buildService(async (statements) => new Set(statements.length > 0 ? [0] : []));
    await svc.emitCitationsAndComplete('user-1', [citation()], subscriber, 0, answer, trace, '年假是多少天？', {
      fingerprint: 'scope-1',
      knowledgeEpoch: 1,
    });
    expect(store).not.toHaveBeenCalled();
  });

  it('does not treat an unreachable judge as verification', async () => {
    // judgeEntailment never throws in production (it swallows and returns an
    // empty set), so an empty set is the realistic outage signal. It must not
    // be read as "nothing was rejected".
    const svc = buildService(async () => new Set<number>());
    await svc.emitCitationsAndComplete('user-1', [citation()], subscriber, 0, groundedAnswer, trace, '年假是多少天？', {
      fingerprint: 'scope-1',
      knowledgeEpoch: 1,
    });
    expect(store).not.toHaveBeenCalled();
  });

  it('skips the judge entirely when the gate is disabled by configuration', async () => {
    process.env.CACHE_ENTAILMENT_GATE = '0';
    const judge = jest.fn(async (statements: string[]) => new Set(statements.map((_, i) => i)));
    const svc = buildService(judge);
    await svc.emitCitationsAndComplete('user-1', [citation()], subscriber, 0, groundedAnswer, trace, '年假是多少天？', {
      fingerprint: 'scope-1',
      knowledgeEpoch: 1,
    });
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('does not consult the judge for answers that are not cacheable anyway', async () => {
    const judge = jest.fn(async (statements: string[]) => new Set(statements.map((_, i) => i)));
    const svc = buildService(judge);
    await svc.emitCitationsAndComplete('user-1', [citation()], subscriber, 0, groundedAnswer, trace, '年假是多少天？', {
      fingerprint: 'scope-1',
      knowledgeEpoch: 1,
      cacheable: false,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
});
