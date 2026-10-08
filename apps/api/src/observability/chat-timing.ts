import { getRequestContext } from './request-context';
import { metricsService } from './metrics.service';

export type ChatPhase = 'queue' | 'authorization' | 'retrieval' | 'reranking' | 'context' | 'generation' | 'verification' | 'persistence';
export type ChatMilestone = 'providerFirstText' | 'answerPrepared' | 'transportFirstText' | 'transportComplete' | 'runReady';
export interface ChatTimingSnapshot {
  schemaVersion: 1; startedAt: string; elapsedMs: number;
  milestonesMs: Partial<Record<ChatMilestone, number>>;
  phases: Partial<Record<ChatPhase, { durationMs: number; spans: number; firstStartedMs: number; lastFinishedMs: number }>>;
}

export class ChatTiming {
  private readonly active = new Map<string, { phase: ChatPhase; at: number }>();
  private readonly intervals = new Map<ChatPhase, Array<[number, number]>>();
  private readonly milestones: Partial<Record<ChatMilestone, number>> = {};
  constructor(readonly startedAt = Date.now()) {}
  start(id: string, phase: ChatPhase): void {
    if (!this.active.has(id)) this.active.set(id, { phase, at: Date.now() });
  }
  finish(id: string): void {
    const span = this.active.get(id);
    if (!span) return;
    this.active.delete(id);
    const end = Date.now();
    const intervals = this.intervals.get(span.phase) || [];
    intervals.push([span.at, end]); this.intervals.set(span.phase, intervals);
    metricsService.observeChatPhase(span.phase, Math.max(0, end - span.at));
  }
  mark(name: ChatMilestone): void {
    if (this.milestones[name] !== undefined) return;
    const elapsed = Math.max(0, Date.now() - this.startedAt);
    this.milestones[name] = elapsed;
    metricsService.observeChatMilestone(name, elapsed);
    if (name === 'transportFirstText') metricsService.observeChatLatency('first_text', elapsed);
  }
  snapshot(): ChatTimingSnapshot {
    const now = Date.now();
    const all = new Map([...this.intervals].map(([phase, values]) => [phase, [...values]]));
    for (const { phase, at } of this.active.values()) {
      const values = all.get(phase) || []; values.push([at, now]); all.set(phase, values);
    }
    const phases: ChatTimingSnapshot['phases'] = {};
    for (const [phase, values] of all) {
      const sorted = values.sort((a, b) => a[0] - b[0]);
      let durationMs = 0; let [start, end] = sorted[0];
      for (const [nextStart, nextEnd] of sorted.slice(1)) {
        if (nextStart <= end) end = Math.max(end, nextEnd);
        else { durationMs += Math.max(0, end - start); start = nextStart; end = nextEnd; }
      }
      phases[phase] = { durationMs: durationMs + Math.max(0, end - start), spans: sorted.length,
        firstStartedMs: Math.max(0, sorted[0][0] - this.startedAt), lastFinishedMs: Math.max(0, end - this.startedAt) };
    }
    return { schemaVersion: 1, startedAt: new Date(this.startedAt).toISOString(), elapsedMs: Math.max(0, now - this.startedAt),
      milestonesMs: { ...this.milestones }, phases };
  }
}

export function getChatTiming(startedAt?: number): ChatTiming {
  const ctx = getRequestContext();
  if (ctx?.chatTiming) return ctx.chatTiming;
  const timing = new ChatTiming(startedAt ?? ctx?.startedAt ?? Date.now());
  if (ctx) ctx.chatTiming = timing;
  return timing;
}

export function timingTraceNode(timing: ChatTiming) {
  const snapshot = timing.snapshot();
  return { id: 'pipeline_timing', name: '响应阶段计量', status: 'success', startedAt: snapshot.startedAt,
    finishedAt: new Date().toISOString(), durationMs: snapshot.elapsedMs,
    details: { ...snapshot, clock: 'server', visibility: 'transport/run readiness; browser paint measured separately' } };
}
