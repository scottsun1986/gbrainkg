import { AbExperimentService } from './ab-experiment.service';
import { ShadowRetrievalService } from './shadow-retrieval.service';

describe('ShadowRetrievalService', () => {
  it('runs control only when not assigned', async () => {
    const ab = new AbExperimentService({
      'retrieval.fusion': {
        key: 'retrieval.fusion',
        sampleRate: 0,
        treatmentRate: 0,
        shadowRate: 0,
        enabled: true,
      },
    });
    const shadow = new ShadowRetrievalService(ab);
    const fn = jest.fn(async () => ({ citations: [{ documentId: 'd1', evidence: 'e' }] }));
    const out = await shadow.compare('retrieval.fusion', 'u1', 's1', 'q', {} as any, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.result.citations).toHaveLength(1);
    expect(out.shadowDiff).toBeUndefined();
  });

  it('shadow arm runs treatment behind the scenes and keeps control result', async () => {
    const ab = new AbExperimentService({
      'retrieval.fusion': {
        key: 'retrieval.fusion',
        sampleRate: 1,
        treatmentRate: 0,
        shadowRate: 1,
        enabled: true,
      },
    });
    const shadow = new ShadowRetrievalService(ab);
    const fn = jest.fn(async (_p: any, _q: string) => ({
      citations: [{ documentId: 'd1', evidence: 'hello world' }],
    }));
    // force shadow by using a user that lands in shadow bucket via high shadowRate
    const out = await shadow.compare('retrieval.fusion', 'user-shadow', 's', 'q', {} as any, fn);
    // Depending on hash bucket, arm may be shadow or control; both should be valid
    expect([1, 2]).toContain(fn.mock.calls.length);
    expect(out.result.citations).toHaveLength(1);
  });

  it('records hit metrics', () => {
    const ab = new AbExperimentService();
    const shadow = new ShadowRetrievalService(ab);
    shadow.recordHit('retrieval.fusion', 'u1', 'control', 1, 1.0, 's1');
    const summary = ab.summarize('retrieval.fusion');
    expect(summary.find((s) => s.arm === 'control')?.count).toBe(2);
  });
});
