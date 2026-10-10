/**
 * Registry of in-flight question/answer runs, keyed by conversation id.
 *
 * The server answers a question with a run id and does the work behind the
 * request's back; the client polls `GET /chat/runs/:runId` for `stage` until
 * the run reports `completed`, at which point the full answer, citations and
 * trace arrive in that same payload. Nothing about a run is tied to an open
 * HTTP connection, so switching conversations — or running several at once —
 * cannot be starved by another turn's updates.
 *
 * Earlier versions kept a single `streaming` boolean with an effect keyed on
 * it. A second send while the first was running called `setStreaming(true)` on
 * an already-true value, React dropped the update, the effect never re-ran and
 * no request was sent at all: the conversation was silently never created.
 * Every start here registers its own entry, so there is no merge point.
 */

export type RunStatus = 'running' | 'completed' | 'failed';

/** Backend stage vocabulary; anything unknown renders as the generic label. */
export type RunStage = 'queued' | 'retrieving' | 'reranking' | 'generating' | 'verifying' | 'persisting';

export interface RunState {
  runId: string;
  conversationId: string;
  status: RunStatus;
  stage: RunStage;
}

export interface RunPollResult extends RunState {
  messageId?: string;
  answer?: string;
  citations?: unknown;
  trace?: unknown;
  latencyMs?: number;
  errorMessage?: string;
}

export type RunMap = Map<string, RunState>;

export const STAGE_LABELS: Record<RunStage, string> = {
  queued: '排队中',
  retrieving: '检索证据',
  reranking: '重排验证',
  generating: '生成回答',
  verifying: '证据核验',
  persisting: '保存结果',
};

export function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Poll interval per stage.
 *
 * Retrieval and reranking hold a run for tens of seconds while producing
 * nothing new to show; generation is when the user is actually waiting. Polling
 * hard during generation and loosely during retrieval keeps request volume flat
 * when several conversations run at once.
 */
export function pollDelayFor(stage: RunStage): number {
  switch (stage) {
    case 'generating':
    case 'verifying':
      return 1000;
    case 'queued':
      return 2000;
    default:
      return 3000;
  }
}

/**
 * Background tabs poll on a slow cadence to stay off the server's hot path.
 * The cost is that a run which finished while the tab was hidden can sit
 * unrendered for a full interval after the user comes back, which reads as a
 * stalled answer. Returning to the foreground therefore warrants an immediate
 * poll rather than the normal (or throttled) delay.
 */
export function pollDelayForVisibility(stage: RunStage, hidden: boolean): number {
  return hidden ? 8000 : pollDelayFor(stage);
}

export function labelForRun(run: RunState | undefined): string | null {
  if (!run) return null;
  if (run.status === 'completed') return '已完成';
  if (run.status === 'failed') return '未完成';
  return STAGE_LABELS[run.stage] ?? '处理中';
}

/**
 * Fold a poll response into the registry.
 *
 * A run that has left the registry (unmounted, cancelled, or completed in
 * another poll) is not resurrected: a late poll response for it must not make
 * a finished conversation spin again.
 */
export function applyPoll(runs: RunMap, conversationId: string, result: RunPollResult): RunMap {
  const next = new Map(runs);
  if (!next.has(conversationId) || next.get(conversationId)?.runId !== result.runId) return next;
  next.set(conversationId, {
    runId: result.runId,
    conversationId,
    status: result.status,
    stage: result.stage,
  });
  if (isTerminal(result.status)) next.delete(conversationId);
  return next;
}

/** Conversation ids with an answer still being produced, for the sidebar. */
export function runningConversationIds(runs: RunMap): string[] {
  return [...runs.keys()];
}
