import { Logger } from '@nestjs/common';
import { RetrievalArmsService } from './retrieval-arms';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  knowledgeBase: { findMany: jest.fn() },
  chunk: { findMany: jest.fn() },
  document: { findMany: jest.fn() },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));

/**
 * AGENTS.md §2 guard: the decomposition/keyword heuristics must be corpus-
 * agnostic. Legal/clause structure (第X章/总则/罚则/附则) is a *corpus shape*
 * and must be switchable (ENABLE_LEGAL_STRUCTURE_BOOST), and the subject
 * lexicon may only contain document-form nouns — never an industry device,
 * department or product of a specific deployment.
 */
describe('corpus-agnostic decomposition (AGENTS.md §2)', () => {
  let service: RetrievalArmsService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLE_LEGAL_STRUCTURE_BOOST;
    delete process.env.RETRIEVAL_BENCHMARK_PATTERNS;
    service = new RetrievalArmsService({
      logger: new Logger('test'),
      prisma: mockPrisma as any,
      gbrain: {} as any,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('keeps clause-shaped decomposition on for legal corpora by default', () => {
    const q = '关于数据出境与加密传输，本规范在第一章总则原则、第六章技术加密指标以及第十章特殊豁免附则中分别有哪些具体硬性要求？';
    const subs = service.decomposeComplexQuery(q);
    expect(subs.some((s) => s.includes('第一章'))).toBe(true);
    expect(subs.some((s) => s.includes('第六章'))).toBe(true);
  });

  it('drops chapter/clause heuristics when the corpus is not legal-shaped', () => {
    process.env.ENABLE_LEGAL_STRUCTURE_BOOST = '0';
    const q = '关于数据出境与加密传输，本规范在第一章总则原则、第六章技术加密指标以及第十章特殊豁免附则中分别有哪些硬性要求？';
    const subs = service.decomposeComplexQuery(q);
    // Chapter *terms from the user's own text* may survive a conjunction split;
    // what must disappear is the fabricated chapter-listing probe.
    expect(subs.some((s) => s === '章 目录' || s === '第一章 第二章')).toBe(false);

    const keywords = service.extractSearchKeywords('第十条对哪些章有要求？附则怎么写的？');
    // Injected anchors absent (none of these appear in the user's text)…
    expect(keywords).not.toContain('第一章');
    expect(keywords).not.toContain('总则');
    expect(keywords).not.toContain('罚则');
    // …while the user's own words still surface via generic n-gram extraction.
    expect(keywords).toContain('附则');
  });

  it('keeps structural anchors on legal corpora in the keyword arm', () => {
    const keywords = service.extractSearchKeywords('第十条对哪些章有要求？附则怎么写的？');
    expect(keywords).toContain('第十条');
    expect(keywords).toContain('附则');
  });

  it('does not inject industry nouns as subject prefixes for sub-queries', () => {
    // The lexicon may only contain document-form nouns. A domain device name
    // must never be extracted as a "subject" and prefixed onto split parts —
    // the parts below come from the user's own conjunction split, unprefixed.
    const subs = service.decomposeComplexQuery('无人机和地面站在什么情况下需要备案？');
    expect(
      subs.some((s) => s.startsWith('无人机 ') || s.startsWith('地面站 ')),
    ).toBe(false);
    // The document-form noun still acts as a subject anchor.
    const docForm = service.decomposeComplexQuery('数据出境安全条例和加密传输办法在什么情况下需要备案？');
    expect(docForm.length).toBeGreaterThan(0);
  });

  it('never runs benchmark-shaped English decomposition unless the flag is set', () => {
    const q = 'Which film has the director who died later, The More The Merrier or Sleep, My Love?';
    const subs = service.decomposeComplexQuery(q);
    // Default: at most the generic interrogative-stripped query — no per-item
    // benchmark probes.
    expect(subs.some((s) => s.includes('The More The Merrier') && s !== q.replace(/\?$/, ''))).toBe(false);
    expect(subs.some((s) => s.includes('Sleep, My Love') && s !== q.replace(/\?$/, ''))).toBe(false);

    process.env.RETRIEVAL_BENCHMARK_PATTERNS = 'true';
    const benchmarked = service.decomposeComplexQuery(q);
    expect(benchmarked.some((s) => s.includes('The More The Merrier'))).toBe(true);
    expect(benchmarked.some((s) => s.includes('Sleep, My Love'))).toBe(true);
  });
});
