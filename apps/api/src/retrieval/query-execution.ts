import { RetrievalDeadline } from './retrieval-budget';
import { getRequestContext } from '../observability/request-context';

export type QueryTier = 'fast' | 'standard' | 'deep';
export const QUERY_PLANS = {
  fast: { dense: 40, lexical: 40, graph: 10, rerank: 40, rounds: 0, probes: 0, context: 4000, calls: 4, inputTokens: 24000, deadlineMs: 1500 },
  standard: { dense: 60, lexical: 60, graph: 20, rerank: 80, rounds: 1, probes: 2, context: 8000, calls: 8, inputTokens: 48000, deadlineMs: 3000 },
  deep: { dense: 80, lexical: 80, graph: 20, rerank: 120, rounds: 2, probes: 4, context: 12000, calls: 16, inputTokens: 96000, deadlineMs: 6000 },
} as const;

// Accuracy-first rollout retains adaptive escalation with enough time for real
// provider calls. These are retrieval budgets, never total answer SLAs.
export const QUALITY_FIRST_PLANS = {
  fast: { ...QUERY_PLANS.fast, context: 8000, calls: 8, inputTokens: 48000, deadlineMs: 30000 },
  standard: { dense: 80, lexical: 80, graph: 30, rerank: 120, rounds: 2, probes: 4, context: 12000, calls: 24, inputTokens: 144000, deadlineMs: 60000 },
  deep: { dense: 120, lexical: 120, graph: 40, rerank: 200, rounds: 3, probes: 6, context: 20000, calls: 48, inputTokens: 288000, deadlineMs: 90000 },
} as const;

/** Initial route uses structural complexity only; evidence may escalate within the same deadline. */
export function initialQueryTier(question: string): QueryTier {
  const clauses = question.split(/[;；?？\n]/u).filter(s => s.trim()).length;
  if (clauses >= 3 || question.length > 240) return 'deep';
  if (clauses > 1 || question.length > 80) return 'standard';
  return 'fast';
}

export class QueryExecution {
  readonly qualityFirst = process.env.RETRIEVAL_QUALITY_PROFILE === 'quality-first';
  readonly planVersion = this.qualityFirst ? 'adaptive-quality-first-v1' : 'adaptive-v1';
  readonly startedAt = Date.now();
  readonly deadline: RetrievalDeadline;
  tier: QueryTier;
  rounds = 0;
  probes = 0;
  pairs = 0;
  private readonly primaryQueries = new Set<string>();
  private readonly seenProbes = new Set<string>();
  modelCalls = 0;
  inputTokens = 0;
  actualPromptTokens = 0;
  actualCompletionTokens = 0;
  usageReports = 0;
  stopReason?: string;
  retrievalComplete = false;
  retrievalMs?: number;
  constructor(question: string, readonly adaptive = process.env.ADAPTIVE_RETRIEVAL_ENABLED === 'true') {
    this.primaryQueries.add(question.trim());
    this.tier = adaptive ? initialQueryTier(question) : 'deep';
    if (adaptive && this.qualityFirst && this.tier === 'fast') this.tier = 'standard';
    this.deadline = new RetrievalDeadline(adaptive ? this.plan.deadlineMs : Number(process.env.RETRIEVAL_DEADLINE_MS || 15000), adaptive ? this.plans.deep.deadlineMs : Number(process.env.RETRIEVAL_DEADLINE_MS || 15000));
  }
  private get plans() { return this.qualityFirst ? QUALITY_FIRST_PLANS : QUERY_PLANS; }
  get plan() { return this.plans[this.tier]; }
  finishRetrieval(): void { this.retrievalComplete = true; this.retrievalMs = Date.now() - this.startedAt; }
  escalate(): boolean {
    if (this.deadline.expired()) { this.stopReason = 'deadline'; return false; }
    if (this.tier === 'deep') return false;
    this.tier = this.tier === 'fast' ? 'standard' : 'deep';
    this.deadline.extendTo(this.plan.deadlineMs);
    return true;
  }
  reserveModelCall(tokens: number): boolean {
    if (!Number.isFinite(tokens) || tokens < 0) return false;
    if (this.adaptive && ((!this.retrievalComplete && this.deadline.expired()) || this.modelCalls >= this.plan.calls || this.inputTokens+tokens > this.plan.inputTokens)) { this.stopReason='model_budget'; return false; }
    this.modelCalls++; this.inputTokens+=tokens; return true;
  }
  recordUsage(usage: any): void {
    if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) return;
    this.actualPromptTokens+=usage.prompt_tokens; this.actualCompletionTokens+=usage.completion_tokens; this.usageReports++;
  }
  reserveProbe(count = 1): boolean {
    if (!Number.isInteger(count) || count < 0) return false;
    if (this.deadline.expired() || this.probes + count > this.plan.probes) { this.stopReason = 'probe_budget'; return false; }
    this.probes += count;
    return true;
  }
  reservePairs(count: number): boolean {
    if (!Number.isInteger(count) || count < 0) return false;
    if (this.deadline.expired() || this.pairs + count > this.plan.rerank) { this.stopReason = 'rerank_budget'; return false; }
    this.pairs += count;
    return true;
  }
  registerPrimaryQuery(query: string): void { this.primaryQueries.add(query.trim()); }
  reserveRound(): boolean {
    if (this.deadline.expired() || this.rounds >= this.plan.rounds) { this.stopReason = 'round_budget'; return false; }
    this.rounds++; return true;
  }
  reserveProbeFor(query: string): boolean {
    query = query.trim();
    if (this.primaryQueries.has(query)) return !this.deadline.expired();
    if (this.seenProbes.has(query)) return !this.deadline.expired();
    if (!this.reserveProbe()) return false;
    this.seenProbes.add(query);
    return true;
  }
  report() { return { planVersion: this.planVersion, tier: this.tier, retrievalMs: this.retrievalMs,
    rounds: this.rounds, probes: this.probes, rerankPairs: this.pairs, modelCalls: this.modelCalls, actualPromptTokens: this.actualPromptTokens, actualCompletionTokens: this.actualCompletionTokens, usageReports: this.usageReports, authRevision: getRequestContext()?.authorization?.revision, versionManifest: getRequestContext()?.evidenceDependencies, estimatedInputTokens: this.inputTokens, stopReason: this.stopReason || 'evidence_complete' }; }
}
export function currentQueryExecution(): QueryExecution | undefined { return getRequestContext()?.execution; }

/** Disabled adaptive retrieval preserves the legacy request lifecycle. */
export function createQueryExecution(question: string): QueryExecution | undefined {
  return process.env.ADAPTIVE_RETRIEVAL_ENABLED === 'true' ? new QueryExecution(question, true) : undefined;
}
