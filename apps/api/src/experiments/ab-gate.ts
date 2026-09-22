/**
 * A/B 回归门禁：对比 control/treatment 的关键指标，treatment 显著劣化则失败。
 * 供 scripts/ab-gate.sh / feedback-gate 调用。无凭据时跳过。
 */
export interface ArmSummary {
  experimentKey: string;
  arm: 'control' | 'treatment' | 'shadow';
  count: number;
  avgValue: number;
  eventNames: Record<string, number>;
}

export interface AbGateResult {
  pass: boolean;
  skipped: boolean;
  reason: string;
  details: Array<{
    experimentKey: string;
    controlAvg: number;
    treatmentAvg: number;
    delta: number;
    pass: boolean;
  }>;
}

/** treatment 均值低于 control 超过 tolerance 则 fail。 */
export function evaluateAbSummaries(
  summaries: ArmSummary[],
  opts: { minSamples?: number; tolerance?: number; metric?: string } = {},
): AbGateResult {
  const minSamples = opts.minSamples ?? 30;
  const tolerance = opts.tolerance ?? 0.05;
  const metric = opts.metric ?? 'hit_at_1';
  const byExp = new Map<string, Partial<Record<string, ArmSummary>>>();
  for (const s of summaries) {
    if (s.eventNames[metric] === undefined && s.count === 0) continue;
    const entry = byExp.get(s.experimentKey) ?? {};
    entry[s.arm] = s;
    byExp.set(s.experimentKey, entry);
  }
  const details: AbGateResult['details'] = [];
  let pass = true;
  let sampled = false;
  for (const [key, arms] of byExp) {
    const control = arms.control;
    const treatment = arms.treatment;
    if (!control || !treatment) continue;
    if (control.count < minSamples || treatment.count < minSamples) continue;
    sampled = true;
    const delta = treatment.avgValue - control.avgValue;
    const ok = delta >= -tolerance;
    if (!ok) pass = false;
    details.push({
      experimentKey: key,
      controlAvg: control.avgValue,
      treatmentAvg: treatment.avgValue,
      delta,
      pass: ok,
    });
  }
  if (!sampled) {
    return {
      pass: true,
      skipped: true,
      reason: `no experiment reached minSamples=${minSamples}`,
      details,
    };
  }
  return {
    pass,
    skipped: false,
    reason: pass
      ? 'all treatment arms within tolerance'
      : 'treatment arm degraded beyond tolerance',
    details,
  };
}
