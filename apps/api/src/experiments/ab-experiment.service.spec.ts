import {
  AbExperimentService,
  assignArm,
  bucketOf,
  ExperimentConfig,
} from './ab-experiment.service';

const cfg: ExperimentConfig = {
  key: 'retrieval.fusion',
  sampleRate: 0.5,
  treatmentRate: 0.5,
  shadowRate: 0.4,
  enabled: true,
};

describe('ab-experiment', () => {
  it('buckets deterministically', () => {
    const a = bucketOf('k', 'user-1', 's1');
    const b = bucketOf('k', 'user-1', 's1');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('is sticky for the same user+session', () => {
    const svc = new AbExperimentService({ 'retrieval.fusion': cfg });
    const a1 = svc.assign('retrieval.fusion', 'u1', 's1');
    const a2 = svc.assign('retrieval.fusion', 'u1', 's1');
    expect(a1).not.toBeNull();
    expect(a1!.arm).toBe(a2!.arm);
    expect(a1!.assignedAt).toBe(a2!.assignedAt);
  });

  it('returns null when experiment disabled', () => {
    const svc = new AbExperimentService({
      'retrieval.fusion': { ...cfg, enabled: false },
    });
    expect(svc.assign('retrieval.fusion', 'u1')).toBeNull();
  });

  it('shadow runs treatment observationally and keeps control result', async () => {
    const svc = new AbExperimentService();
    const assignment = assignArm({ ...cfg, sampleRate: 1, treatmentRate: 0, shadowRate: 1 }, 'u1', 's1');
    expect(assignment.arm).toBe('shadow');
    const out = await svc.runWithShadow(
      assignment,
      async () => 'control-answer',
      async () => 'treatment-answer',
      (a, b) => ({ a, b, same: a === b }),
    );
    expect(out.result).toBe('control-answer');
    expect(out.shadowDiff).toMatchObject({ a: 'control-answer', b: 'treatment-answer', same: false });
    const summary = svc.summarize('retrieval.fusion');
    // runWithShadow records shadow_diff into the default service's events
  });

  it('treatment returns treatment result', async () => {
    const svc = new AbExperimentService();
    const assignment = assignArm({ ...cfg, sampleRate: 1, treatmentRate: 1, shadowRate: 0 }, 'u2', 's2');
    expect(assignment.arm).toBe('treatment');
    const out = await svc.runWithShadow(
      assignment,
      async () => 'c',
      async () => 't',
    );
    expect(out.result).toBe('t');
  });

  it('summarizes metrics per arm', () => {
    const svc = new AbExperimentService();
    svc.record({
      experimentKey: 'retrieval.fusion',
      userId: 'u1',
      arm: 'control',
      eventName: 'hit_at_1',
      value: 1,
      ts: new Date().toISOString(),
    });
    svc.record({
      experimentKey: 'retrieval.fusion',
      userId: 'u2',
      arm: 'treatment',
      eventName: 'hit_at_1',
      value: 0,
      ts: new Date().toISOString(),
    });
    svc.record({
      experimentKey: 'retrieval.fusion',
      userId: 'u3',
      arm: 'treatment',
      eventName: 'hit_at_1',
      value: 1,
      ts: new Date().toISOString(),
    });
    const summary = svc.summarize('retrieval.fusion');
    const treatment = summary.find((s) => s.arm === 'treatment')!;
    expect(treatment.count).toBe(2);
    expect(treatment.avgValue).toBeCloseTo(0.5);
  });
});
