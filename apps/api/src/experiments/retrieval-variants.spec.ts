import {
  CONTROL_VARIANT,
  TREATMENT_VARIANT,
  applyVariantParams,
  diffCitationSets,
} from './retrieval-variants';

describe('retrieval-variants', () => {
  it('keeps control defaults stable', () => {
    expect(CONTROL_VARIANT.rrfK).toBeGreaterThanOrEqual(20);
    expect(TREATMENT_VARIANT.subqueryProbesMax).toBeGreaterThanOrEqual(
      CONTROL_VARIANT.subqueryProbesMax!,
    );
  });

  it('maps variant params to env overrides', () => {
    const env = applyVariantParams(TREATMENT_VARIANT);
    expect(env.RETRIEVAL_RRF_K).toBe(String(TREATMENT_VARIANT.rrfK));
    expect(env.RETRIEVAL_SUBQUERY_PROBES_MAX).toBe(String(TREATMENT_VARIANT.subqueryProbesMax));
  });

  it('diffs citation sets and computes jaccard', () => {
    const control = [
      { documentId: 'd1', evidence: 'alpha beta gamma' },
      { documentId: 'd2', evidence: 'delta epsilon' },
    ];
    const treatment = [
      { documentId: 'd1', evidence: 'alpha beta gamma' },
      { documentId: 'd3', evidence: 'zeta eta' },
    ];
    const diff = diffCitationSets(control, treatment);
    expect(diff.overlap).toBe(1);
    expect(diff.controlSize).toBe(2);
    expect(diff.treatmentSize).toBe(2);
    expect(Number(diff.jaccard)).toBeCloseTo(1 / 3);
  });
});
