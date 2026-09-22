import { evaluateAbSummaries } from './ab-gate';

describe('evaluateAbSummaries', () => {
  it('passes when treatment within tolerance', () => {
    const result = evaluateAbSummaries([
      { experimentKey: 'e1', arm: 'control', count: 50, avgValue: 0.8, eventNames: { hit_at_1: 50 } },
      { experimentKey: 'e1', arm: 'treatment', count: 50, avgValue: 0.78, eventNames: { hit_at_1: 50 } },
    ]);
    expect(result.pass).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it('fails when treatment degraded beyond tolerance', () => {
    const result = evaluateAbSummaries([
      { experimentKey: 'e1', arm: 'control', count: 50, avgValue: 0.8, eventNames: { hit_at_1: 50 } },
      { experimentKey: 'e1', arm: 'treatment', count: 50, avgValue: 0.6, eventNames: { hit_at_1: 50 } },
    ]);
    expect(result.pass).toBe(false);
    expect(result.details[0].delta).toBeCloseTo(-0.2);
  });

  it('skips when not enough samples', () => {
    const result = evaluateAbSummaries([
      { experimentKey: 'e1', arm: 'control', count: 5, avgValue: 0.8, eventNames: {} },
      { experimentKey: 'e1', arm: 'treatment', count: 5, avgValue: 0.1, eventNames: {} },
    ]);
    expect(result.skipped).toBe(true);
    expect(result.pass).toBe(true);
  });
});
