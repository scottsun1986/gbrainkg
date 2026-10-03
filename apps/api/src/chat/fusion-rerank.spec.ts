import { FusionRerankService } from './fusion-rerank';
import type { RetrievedEvidence } from '../retrieval/weknora-client';

/**
 * Fusion decides the candidate order the reranker and the answer builder see, so
 * its arithmetic and its dedupe keys are correctness-critical: a wrong RRF
 * denominator or a key collision silently changes which evidence reaches the
 * model. These cases pin the properties the retrieval path depends on.
 */
describe('FusionRerankService.fuseWithWeKnoraRRF', () => {
  const logger = { debug: () => undefined, warn: () => undefined, log: () => undefined } as any;
  const service = new FusionRerankService({ logger });

  const base = (docId: string, text: string, over: Record<string, any> = {}) => ({
    docId,
    kbId: 'kb-1',
    evidence: text,
    snippet: text,
    context: text,
    score: 0.5,
    ...over,
  });

  const external = (documentId: string, content: string, over: Partial<RetrievedEvidence> = {}): RetrievedEvidence => ({
    provider: 'weknora',
    externalChunkId: `ext-${documentId}-${content.length}`,
    documentId,
    kbId: 'kb-1',
    documentVersion: 1,
    content,
    score: 0.5,
    ...over,
  });

  const originalWeight = process.env.WEKNORA_RRF_WEIGHT;
  afterEach(() => {
    if (originalWeight === undefined) delete process.env.WEKNORA_RRF_WEIGHT;
    else process.env.WEKNORA_RRF_WEIGHT = originalWeight;
  });

  it('returns the base list untouched when the external arm is empty', () => {
    const citations = [base('doc-a', '第一段')];
    expect(service.fuseWithWeKnoraRRF(citations, [])).toBe(citations);
  });

  it('scores an external-only result by reciprocal rank with k=60', () => {
    const fused = service.fuseWithWeKnoraRRF([], [external('doc-a', 'alpha'), external('doc-b', 'beta')]);
    expect(fused.map((f) => f.docId)).toEqual(['doc-a', 'doc-b']);
    expect(fused[0].rrfScore).toBeCloseTo(1 / 61, 10);
    expect(fused[1].rrfScore).toBeCloseTo(1 / 62, 10);
  });

  it('adds both arms when the same passage is retrieved by each, and marks it dual verified', () => {
    const fused = service.fuseWithWeKnoraRRF([base('doc-a', '相同的文本')], [external('doc-a', '相同的文本')]);
    expect(fused).toHaveLength(1);
    // Two rank-0 contributions plus the one-off document corroboration bonus.
    expect(fused[0].rrfScore).toBeCloseTo(3 / 61, 10);
    expect(fused[0].dualVerified).toBe(true);
    expect(fused[0].providers).toEqual(expect.arrayContaining(['local_gbrain', 'weknora']));
  });

  it('dedupes passages on normalised whitespace, not raw text', () => {
    const fused = service.fuseWithWeKnoraRRF([base('doc-a', '相同 的\n文本')], [external('doc-a', '相同的文本')]);
    expect(fused).toHaveLength(1);
  });

  it('keeps different passages of one document as separate candidates', () => {
    const fused = service.fuseWithWeKnoraRRF([base('doc-a', '第一段')], [external('doc-a', '第二段')]);
    expect(fused).toHaveLength(2);
  });

  it('applies the document corroboration bonus once, to the strongest base passage only', () => {
    // doc-a is surfaced by both engines with different passages. Only the
    // stronger base passage (rank 0) gets the bonus; the weaker one does not.
    const fused = service.fuseWithWeKnoraRRF(
      [base('doc-a', '强段落'), base('doc-a', '弱段落')],
      [external('doc-a', '外部段落')],
    );
    const strong = fused.find((f) => f.evidence === '强段落')!;
    const weak = fused.find((f) => f.evidence === '弱段落')!;
    expect(strong.rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 10);
    expect(weak.rrfScore).toBeCloseTo(1 / 62, 10);
    expect(strong.dualVerified).toBe(true);
    expect(weak.dualVerified).toBe(true);
  });

  it('rewards agreement across arms over a single top rank', () => {
    // doc-both is second locally and first externally; doc-solo leads locally only.
    const fused = service.fuseWithWeKnoraRRF(
      [base('doc-solo', 'solo'), base('doc-both', 'shared')],
      [external('doc-both', 'shared')],
    );
    expect(fused[0].docId).toBe('doc-both');
  });

  it('scales the external contribution by WEKNORA_RRF_WEIGHT', () => {
    process.env.WEKNORA_RRF_WEIGHT = '0.5';
    const fused = service.fuseWithWeKnoraRRF([base('doc-x', 'local')], [external('doc-y', 'remote')]);
    const remote = fused.find((f) => f.docId === 'doc-y')!;
    expect(remote.rrfScore).toBeCloseTo(0.5 / 61, 10);
  });

  it('returns results sorted by fused score, best first', () => {
    const fused = service.fuseWithWeKnoraRRF(
      [base('doc-1', 'a'), base('doc-2', 'b'), base('doc-3', 'c')],
      [external('doc-3', 'c')],
    );
    const scores = fused.map((f) => f.rrfScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('FusionRerankService helper predicates', () => {
  const logger = { debug: () => undefined, warn: () => undefined, log: () => undefined } as any;
  const service = new FusionRerankService({ logger });

  it('normalises titles so file extension, case and punctuation do not block a match', () => {
    expect(service.normalizeTitleForMatch('《员工手册》（2023版）.pdf')).toBe(
      service.normalizeTitleForMatch('《员工手册》(2023版)'),
    );
    expect(service.normalizeTitleForMatch('Annual_Report.DOCX')).toBe('annualreport');
  });

  it('extracts unicode-aware capitalised candidates without truncating names', () => {
    const names = service.extractCapitalisedCandidates('The film was directed by Andrei Ujică in Bucharest.');
    expect(names.some((n) => n.includes('Ujică'))).toBe(true);
  });
});
