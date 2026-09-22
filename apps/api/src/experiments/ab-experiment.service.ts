/**
 * 在线 A/B 影子流量与指标回流。
 * 设计原则：
 * - 影子（shadow）变体只记录差异，不影响主回答；
 * - 评估变体（treatment）可灰度放量，通过 assignment sticky；
 * - 指标写入 FeedbackCase/A-B 指标表，供反馈门禁与发布决策。
 */
import { createHash, randomUUID } from 'node:crypto';

export type ExperimentArm = 'control' | 'treatment' | 'shadow';

export interface ExperimentConfig {
  key: string;
  /** 0-1，进入 experiment 的流量比例 */
  sampleRate: number;
  /** 0-1，进入 treatment 的比例（其余 control） */
  treatmentRate: number;
  /** 0-1，额外影子对比流量（不影响主路径） */
  shadowRate: number;
  enabled: boolean;
}

export interface Assignment {
  experimentKey: string;
  userId: string;
  sessionId?: string;
  arm: ExperimentArm;
  assignedAt: string;
  variantParams: Record<string, unknown>;
}

export interface AbEvent {
  experimentKey: string;
  userId: string;
  sessionId?: string;
  arm: ExperimentArm;
  eventName: string;
  value?: number;
  metadata?: Record<string, unknown>;
  ts: string;
}

const DEFAULT_EXPERIMENTS: Record<string, ExperimentConfig> = {
  'retrieval.fusion': {
    key: 'retrieval.fusion',
    sampleRate: 0.1,
    treatmentRate: 0.5,
    shadowRate: 0.2,
    enabled: false,
  },
  'retrieval.rerank': {
    key: 'retrieval.rerank',
    sampleRate: 0.1,
    treatmentRate: 0.5,
    shadowRate: 0.1,
    enabled: false,
  },
};

/** 确定性分桶：同 user+key 恒定，便于 sticky assignment。 */
export function bucketOf(...parts: string[]): number {
  const h = createHash('sha256').update(parts.join('|')).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

export function assignArm(
  config: ExperimentConfig,
  userId: string,
  sessionId = '',
  overrides?: Partial<Assignment>,
): Assignment {
  const r = bucketOf(config.key, userId, sessionId || 'anon');
  const r2 = bucketOf(config.key, 'shadow', userId, sessionId || 'anon');
  let arm: ExperimentArm = 'control';
  if (config.enabled) {
    if (r < config.sampleRate * config.treatmentRate) arm = 'treatment';
    else if (r < config.sampleRate) arm = 'control';
    else if (r2 < config.shadowRate) arm = 'shadow';
    else arm = 'control';
    // shadow arm is orthogonal: force a fraction of sampled traffic to also
    // run the treatment pipeline in shadow mode without switching the answer.
    if (arm === 'control' && r2 < config.shadowRate * 0.5) arm = 'shadow';
  }
  return {
    experimentKey: config.key,
    userId,
    sessionId: sessionId || undefined,
    arm,
    assignedAt: new Date().toISOString(),
    variantParams: overrides?.variantParams ?? {},
  };
}

export class AbExperimentService {
  private readonly configs: Map<string, ExperimentConfig>;
  private readonly events: AbEvent[] = [];
  private readonly assignments = new Map<string, Assignment>();

  constructor(configs: Record<string, ExperimentConfig> = DEFAULT_EXPERIMENTS) {
    this.configs = new Map(Object.entries(configs));
  }

  upsertConfig(config: ExperimentConfig) {
    this.configs.set(config.key, config);
  }

  getConfig(key: string): ExperimentConfig | undefined {
    return this.configs.get(key);
  }

  /** sticky：同一 user+session+experiment 只分配一次 */
  assign(experimentKey: string, userId: string, sessionId?: string): Assignment | null {
    const config = this.configs.get(experimentKey);
    if (!config || !config.enabled) return null;
    const cacheKey = `${experimentKey}:${userId}:${sessionId || ''}`;
    const cached = this.assignments.get(cacheKey);
    if (cached) return cached;
    const assignment = assignArm(config, userId, sessionId);
    this.assignments.set(cacheKey, assignment);
    return assignment;
  }

  /**
   * 影子执行：control/treatment 都跑 fn，treatment 的结果只记录不返回。
   * 返回 control 的结果以保证主路径不变。
   */
  async runWithShadow<T>(
    assignment: Assignment | null,
    controlFn: () => Promise<T>,
    treatmentFn: () => Promise<T>,
    diffFn?: (a: T, b: T) => Record<string, unknown>,
  ): Promise<{ result: T; shadowDiff?: Record<string, unknown> }> {
    if (!assignment || assignment.arm === 'control') {
      return { result: await controlFn() };
    }
    if (assignment.arm === 'treatment') {
      return { result: await treatmentFn() };
    }
    // shadow: primary is control, treatment is observational only
    const result = await controlFn();
    let shadowDiff: Record<string, unknown> | undefined;
    try {
      const shadowResult = await treatmentFn();
      shadowDiff = diffFn ? diffFn(result, shadowResult) : { shadowRun: true };
      this.record({
        experimentKey: assignment.experimentKey,
        userId: assignment.userId,
        sessionId: assignment.sessionId,
        arm: 'shadow',
        eventName: 'shadow_diff',
        metadata: shadowDiff,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      this.record({
        experimentKey: assignment.experimentKey,
        userId: assignment.userId,
        sessionId: assignment.sessionId,
        arm: 'shadow',
        eventName: 'shadow_error',
        metadata: { message: err instanceof Error ? err.message : String(err) },
        ts: new Date().toISOString(),
      });
    }
    return { result, shadowDiff };
  }

  record(event: AbEvent) {
    this.events.push(event);
  }

  /** 指标回流：按 experiment+arm 聚合，供发布门禁消费。 */
  summarize(experimentKey?: string): Array<{
    experimentKey: string;
    arm: ExperimentArm;
    count: number;
    avgValue: number;
    eventNames: Record<string, number>;
  }> {
    const grouped = new Map<string, AbEvent[]>();
    for (const e of this.events) {
      if (experimentKey && e.experimentKey !== experimentKey) continue;
      const k = `${e.experimentKey}:${e.arm}`;
      const list = grouped.get(k) ?? [];
      list.push(e);
      grouped.set(k, list);
    }
    return [...grouped.entries()].map(([k, list]) => {
      const [exp, arm] = k.split(':') as [string, ExperimentArm];
      const values = list.map((e) => e.value).filter((v): v is number => typeof v === 'number');
      const eventNames: Record<string, number> = {};
      for (const e of list) eventNames[e.eventName] = (eventNames[e.eventName] || 0) + 1;
      return {
        experimentKey: exp,
        arm,
        count: list.length,
        avgValue: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
        eventNames,
      };
    });
  }

  drainEvents(): AbEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
