import { QueryExecution, createQueryExecution } from './query-execution';
import { parseAsOf } from './as-of';

describe('one query execution budget', () => {
  const previousProfile = process.env.RETRIEVAL_QUALITY_PROFILE;
  beforeEach(() => { delete process.env.RETRIEVAL_QUALITY_PROFILE; });
  afterEach(() => { if (previousProfile === undefined) delete process.env.RETRIEVAL_QUALITY_PROFILE; else process.env.RETRIEVAL_QUALITY_PROFILE = previousProfile; });
  afterEach(() => jest.useRealTimers());
  it('escalates the original deadline without restarting elapsed time', () => {
    jest.useFakeTimers();
    const execution = new QueryExecution('short question', true);
    jest.advanceTimersByTime(1000);
    expect(execution.escalate()).toBe(true);
    expect(execution.deadline.remainingMs()).toBe(2000);
    jest.advanceTimersByTime(500);
    expect(execution.escalate()).toBe(true);
    expect(execution.deadline.remainingMs()).toBe(4500);
    jest.advanceTimersByTime(4501);
    expect(execution.reserveProbeFor('new question')).toBe(false);
    expect(execution.reservePairs(1)).toBe(false);
  });
  it('charges new probes and pairs across branches; answer calls retain the shared limit', () => {
    const execution = new QueryExecution('initial', true);
    execution.escalate();
    execution.registerPrimaryQuery('rewritten');
    expect(execution.reserveProbeFor('rewritten')).toBe(true);
    expect(execution.reserveProbeFor('probe A')).toBe(true);
    expect(execution.reserveProbeFor('probe A')).toBe(true);
    expect(execution.reserveProbeFor('probe B')).toBe(true);
    expect(execution.reserveProbeFor('probe C')).toBe(false);
    expect(execution.probes).toBe(2);
    expect(execution.reservePairs(79)).toBe(true);
    expect(execution.reservePairs(2)).toBe(false);
    expect(execution.reservePairs(-1)).toBe(false);
    for (let i=0;i<6;i++) expect(execution.reserveModelCall(1)).toBe(true);
    expect(execution.reserveModelCall(1)).toBe(false);
    execution.finishRetrieval();
    expect(execution.reserveModelCall(1)).toBe(true);
    expect(execution.reserveModelCall(1)).toBe(true);
    expect(execution.reserveModelCall(1)).toBe(false);
    expect(execution.reserveModelCall(NaN)).toBe(false);
  });
});
describe('explicit historical query timestamp', () => {
  it('preserves equivalent timezone instants', () => {
    expect(parseAsOf('2024-02-29T08:00:00+08:00')).toBe(parseAsOf('2024-02-29T00:00:00Z'));
  });
  it.each(['2023-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01','2026-01-01T00:00:00','2026-01-01T00:00:60Z'])( 'rejects invalid or ambiguous timestamp %s', value => {
    expect(() => parseAsOf(value)).toThrow();
  });
});

describe('adaptive rollout boundary', () => {
  const previous = process.env.ADAPTIVE_RETRIEVAL_ENABLED;
  afterEach(() => { if (previous === undefined) delete process.env.ADAPTIVE_RETRIEVAL_ENABLED; else process.env.ADAPTIVE_RETRIEVAL_ENABLED = previous; });
  it.each([undefined, 'false', '0'])('does not impose a request-wide deadline when flag=%s', value => {
    if (value === undefined) delete process.env.ADAPTIVE_RETRIEVAL_ENABLED;
    else process.env.ADAPTIVE_RETRIEVAL_ENABLED = value;
    expect(createQueryExecution('question')).toBeUndefined();
  });
  it('enforces the adaptive deadline only after explicit enablement', () => {
    process.env.ADAPTIVE_RETRIEVAL_ENABLED = 'true';
    expect(createQueryExecution('question')?.adaptive).toBe(true);
  });
});

describe('accuracy-first adaptive profile', () => {
  const previous = process.env.RETRIEVAL_QUALITY_PROFILE;
  beforeEach(() => { jest.useFakeTimers(); process.env.RETRIEVAL_QUALITY_PROFILE = 'quality-first'; });
  afterEach(() => { jest.useRealTimers(); if (previous === undefined) delete process.env.RETRIEVAL_QUALITY_PROFILE; else process.env.RETRIEVAL_QUALITY_PROFILE = previous; });
  it('does not send short questions through the 1.5 second speed budget', () => {
    const execution = new QueryExecution('short', true);
    expect(execution.tier).toBe('standard');
    jest.advanceTimersByTime(26000);
    expect(execution.reservePairs(120)).toBe(true);
    expect(execution.escalate()).toBe(true);
    expect(execution.deadline.remainingMs()).toBe(64000);
    expect(execution.plan.context).toBe(20000);
  });
  it('keeps total calls bounded after retrieval finishes without cancelling generation by the retrieval deadline', () => {
    const execution = new QueryExecution('short', true);
    execution.finishRetrieval(); jest.advanceTimersByTime(90001);
    for (let i=0;i<24;i++) expect(execution.reserveModelCall(1)).toBe(true);
    expect(execution.reserveModelCall(1)).toBe(false);
  });
});

describe('query arm contribution ledger', () => {
  it('counts shared candidates separately from unique, consumed evidence', () => {
    const execution = new QueryExecution('q');
    const a = { id: 'a', documentId: 'doc', documentVersionId: 'v1', content: 'evidence' };
    const b = { id: 'b', documentId: 'doc', documentVersionId: 'v1', content: 'other' };
    execution.startArm('dense'); execution.finishArm('dense', [a, b, a]);
    execution.startArm('lexical'); execution.finishArm('lexical', [a]);
    execution.skipArm('graph', 'disabled');
    execution.recordEvidenceStage('authorized', [a]);
    execution.recordEvidenceStage('reranked', [a]);
    execution.recordEvidenceStage('context', [a]);
    execution.recordEvidenceStage('citations', [a]);
    expect(execution.report().arms.dense).toMatchObject({ uniqueCandidates: 1, authorized: 1, reranked: 1, contextTokens: 2, finalCitations: 1 });
    expect(execution.report().arms.graph).toMatchObject({ started: false, skippedReason: 'disabled' });
    execution.recordEvidenceStage('citations', [{ ...a, evidenceId: undefined, documentVersionId: 'v2' }]);
    expect(execution.report().arms.dense.finalCitations).toBe(0);
  });

  it('summarizes channel contributions for budget decisions (F07)', () => {
    const execution = new QueryExecution('q');
    const a = { id: 'a', documentId: 'doc', documentVersionId: 'v1', content: 'evidence' };
    const b = { id: 'b', documentId: 'doc', documentVersionId: 'v1', content: 'other' };
    execution.startArm('dense'); execution.finishArm('dense', [a]);
    execution.startArm('graph'); execution.finishArm('graph', [b]);
    execution.skipArm('sparse', 'disabled');
    execution.recordEvidenceStage('context', [a]);
    execution.recordEvidenceStage('citations', [a]);
    const contributions = execution.report().contributions;
    // Sorted by final citations, then unique candidates: the arm that produced
    // evidence the answer consumed ranks first, skipped arms keep their reason.
    expect(contributions[0]).toMatchObject({ channel: 'dense', uniqueCandidates: 1, finalCitations: 1 });
    expect(contributions.find((row) => row.channel === 'graph')).toMatchObject({ uniqueCandidates: 1, finalCitations: 0 });
    expect(contributions.find((row) => row.channel === 'sparse')).toMatchObject({ started: false, skippedReason: 'disabled' });
  });
});
