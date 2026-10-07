import { decideEvidenceSufficiency } from './evidence-sufficiency';
import { runWithRequestContext } from '../observability/request-context';

describe('held-out refusal operating point', () => {
  const options = { calibratedFloor: 0.35, syntheticFloor: 0.999 };
  const decision = (citations: any[]) => runWithRequestContext({ requestId: 'threshold', execution: { qualityFirst: true } as any }, () => decideEvidenceSufficiency(citations, options));
  it('uses the matched learned threshold rather than a global score floor', () => {
    expect(decision([{ scoreSource: 'rerank', calibratedProbability: 0.6, calibratedRefusalThreshold: 0.8 }]).hasSufficientEvidence).toBe(false);
    expect(decision([{ scoreSource: 'rerank', calibratedProbability: 0.6, calibratedRefusalThreshold: 0.5 }]).hasSufficientEvidence).toBe(true);
    expect(decision([{ scoreSource: 'rerank', score: 0.99, calibratedProbability: 0.6, calibratedRefusalThreshold: 0.8 }]).hasSufficientEvidence).toBe(false);
  });
  it('evaluates mixed routes independently and excludes synthetic scores', () => {
    expect(decision([
      { scoreSource: 'rerank', calibratedProbability: 0.7, calibratedRefusalThreshold: 0.8 },
      { scoreSource: 'rerank', calibratedProbability: 0.4, calibratedRefusalThreshold: 0.3 },
      { scoreSource: 'synthetic', score: 1 },
    ]).hasSufficientEvidence).toBe(true);
    expect(decision([{ scoreSource: 'synthetic', calibratedProbability: 1, calibratedRefusalThreshold: 0.1 }]).hasSufficientEvidence).toBe(false);
    expect(runWithRequestContext({ requestId: 'adaptive', execution: { adaptive: true } as any }, () => decideEvidenceSufficiency([{ scoreSource: 'synthetic', calibratedProbability: 1, calibratedRefusalThreshold: 0.1 }], options)).hasSufficientEvidence).toBe(false);
  });
  it('never invokes unknown-confidence fallback for a known failed probability threshold', () => {
    for (const score of [undefined, 0]) {
      const result = runWithRequestContext({ requestId: 'legacy-quality', execution: { qualityFirst: true, adaptive: false } as any }, () => decideEvidenceSufficiency([
        { docId: 'original-doc', context: 'Published original evidence', scoreSource: 'rerank', score, calibratedProbability: 0.4, calibratedRefusalThreshold: 0.7 },
      ], { ...options, verifyUncalibrated: true }));
      expect(result.scoreCalibrated).toBe(true);
      expect(result.hasSufficientEvidence).toBe(false);
      expect(result.maxEvidenceScore).toBe(0.4);
    }
  });
});
