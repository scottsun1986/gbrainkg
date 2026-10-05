import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { authorizationEnforced } from '../permission/authorization-revision';
import { validateEvidenceDependencies } from '../permission/evidence-dependencies';

/**
 * Non-streaming question/answer runs.
 *
 * The client POSTs a question, receives a run id immediately, and polls
 * {@link get} for `stage` until the run reports `completed`, at which point the
 * full answer, citations and trace come back in the same payload. The sidebar
 * uses the same record to mark conversations that are still waiting on an
 * answer.
 *
 * Status lives in Postgres rather than process memory because production runs
 * two instances behind one gateway: a poll that lands on the instance which did
 * not start the run still has to see it. The AbortController cannot be shared
 * that way, so cancellation is best-effort within one process and the stream
 * deadline (see `stream-deadline.ts`) is the cross-instance backstop.
 */

export type ChatRunStage = 'queued' | 'retrieving' | 'reranking' | 'generating' | 'verifying' | 'persisting';

export interface ChatRunView {
  runId: string;
  conversationId: string;
  status: 'running' | 'completed' | 'failed';
  stage: ChatRunStage;
  messageId?: string;
  answer?: string;
  citations?: unknown;
  trace?: unknown;
  latencyMs?: number;
  errorMessage?: string;
}

const STAGES: ReadonlySet<string> = new Set<ChatRunStage>([
  'queued', 'retrieving', 'reranking', 'generating', 'verifying', 'persisting',
]);

@Injectable()
export class ChatRunService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatRunService.name);
  private readonly prisma = getPrismaClient();
  /** In-process cancellation handles, keyed by run id. */
  private readonly controllers = new Map<string, AbortController>();
  private reapTimer?: ReturnType<typeof setInterval>;
  /** Client-lease expiry timers, keyed by run id. */
  private readonly leases = new Map<string, ReturnType<typeof setTimeout>>();

  async start(conversationId: string, userId: string): Promise<ChatRunView> {
    const controller = new AbortController();
    const run = await this.prisma.chatRun.create({
      data: { conversationId, userId, status: 'running', stage: 'queued' },
      select: { id: true, conversationId: true },
    });
    this.controllers.set(run.id, controller);
    this.touch(run.id);
    return { runId: run.id, conversationId: run.conversationId, status: 'running', stage: 'queued' };
  }

  /**
   * The signal a run's pipeline observes.
   *
   * Registered by `handleChatStream` when the pipeline starts, so the status
   * endpoint can renew the client lease and so cancellation has something to
   * abort even when it arrives after the POST response has closed.
   */
  signalFor(runId: string): AbortSignal | undefined {
    return this.controllers.get(runId)?.signal;
  }

  /**
   * A client poll arrived: the run is still wanted, so renew its lease.
   *
   * A non-streaming run's POST response is closed before the work finishes, so
   * there is no transport close event to abort on — a browser tab closed
   * outright would otherwise leave the pipeline running to its full deadline,
   * burning model quota and retrieval budget for an answer nobody will read.
   * Polling is the only liveness signal available, so the lease is renewed here
   * and expires `CHAT_RUN_LEASE_MS` after the last poll.
   */
  touch(runId: string): void {
    const entry = this.controllers.get(runId);
    if (!entry) return;
    this.clearLease(runId);
    const leaseMs = Number(process.env.CHAT_RUN_LEASE_MS || 5 * 60 * 1000);
    if (!(leaseMs > 0)) return;
    const timer = setTimeout(() => {
      this.leases.delete(runId);
      const controller = this.controllers.get(runId);
      if (!controller || controller.signal.aborted) return;
      controller.abort(new Error('Chat run client lease expired'));
      void this.fail(runId, '客户端已断开，回答未完成。');
    }, leaseMs);
    timer.unref?.();
    this.leases.set(runId, timer);
  }

  private clearLease(runId: string): void {
    const timer = this.leases.get(runId);
    if (timer) clearTimeout(timer);
    this.leases.delete(runId);
  }

  /** Called by the pipeline once its cancellation signal exists. */
  attachSignal(runId: string, signal: AbortSignal): void {
    if (!this.controllers.has(runId)) this.controllers.set(runId, new AbortController());
    this.touch(runId);
    const existing = this.controllers.get(runId)!;
    if (existing.signal.aborted) return;
    signal.addEventListener('abort', () => { if (!existing.signal.aborted) existing.abort(signal.reason); }, { once: true });
  }


  async setStage(runId: string, stage: string): Promise<void> {
    // A late stage report from a run that already finished must not reopen it.
    if (!STAGES.has(stage)) return;
    try {
      await this.prisma.chatRun.updateMany({
        where: { id: runId, status: 'running' },
        data: { stage },
      });
    } catch (error) {
      // Progress is advisory: a failed stage write must never fail the answer.
      this.logger.debug(`chat run ${runId}: stage ${stage} not recorded: ${(error as Error).message}`);
    }
  }

  /**
   * Close the run as completed.
   *
   * Guarded on `status: 'running'` so it cannot overwrite a terminal state:
   * the user may cancel in the same tick the pipeline finishes, and an
   * unconditional write let whichever landed last win — the user was then told
   * "stopped" while a complete answer sat in the database, or the reverse.
   */
  async complete(runId: string, messageId: string): Promise<void> {
    this.clearLease(runId);
    this.controllers.delete(runId);
    try {
      await this.prisma.chatRun.updateMany({
        where: { id: runId, status: 'running' },
        data: { status: 'completed', stage: 'persisting', messageId, completedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(`chat run ${runId}: completion not recorded: ${(error as Error).message}`);
    }
  }

  /** Terminal failure. Also guarded, so a late failure cannot clobber success. */
  async fail(runId: string, message: string): Promise<void> {
    this.clearLease(runId);
    this.controllers.delete(runId);
    try {
      await this.prisma.chatRun.updateMany({
        where: { id: runId, status: 'running' },
        data: { status: 'failed', errorMessage: message.slice(0, 2000), completedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(`chat run ${runId}: failure not recorded: ${(error as Error).message}`);
    }
  }

  /**
   * Best-effort cancel.
   *
   * The AbortController is process-local, so a run started by the other
   * instance (production runs inst1 + inst2) cannot be aborted from here; the
   * caller's stream deadline remains the backstop for that case. The boolean
   * says which happened, so the endpoint can tell the user the truth rather
   * than reporting a stop that did nothing.
   */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    this.clearLease(runId);
    controller.abort(new Error('Chat run cancelled'));
    return true;
  }

  /**
   * Read a run. Throws NotFound rather than leaking existence when the run
   * belongs to somebody else, matching the trace endpoint's behaviour.
   */
  async get(userId: string, runId: string): Promise<ChatRunView> {
    const run = await this.prisma.chatRun.findFirst({
      where: { id: runId, userId },
      select: {
        id: true, conversationId: true, status: true, stage: true,
        messageId: true, errorMessage: true, startedAt: true, completedAt: true,
      },
    });
    if (!run) throw new NotFoundException('Chat run not found.');

    const view: ChatRunView = {
      runId: run.id,
      conversationId: run.conversationId,
      status: (run.status === 'completed' || run.status === 'failed' ? run.status : 'running') as ChatRunView['status'],
      stage: (STAGES.has(run.stage) ? run.stage : 'queued') as ChatRunStage,
    };
    if (run.status === 'failed') view.errorMessage = run.errorMessage || '问答未成功完成。';
    if (run.status === 'completed' && run.messageId) {
      const message = await this.prisma.message.findFirst({
        where: { id: run.messageId, conversationId: run.conversationId, conversation: { userId } },
        select: { id: true, content: true, citationsSummary: true, processingTrace: true, latencyMs: true, dependencyManifest: true },
      });
      if (message) {
        view.messageId = message.id;
        // Polling returns the same stored answer as conversation history, so
        // it must apply the same live ACL, version and temporal checks.
        if (authorizationEnforced() && !await validateEvidenceDependencies(userId, message.dependencyManifest)) {
          view.answer = '该回答的来源已失效或您已无权访问。';
          view.citations = [];
          view.trace = [];
          return view;
        }
        view.answer = message.content;
        view.citations = message.citationsSummary ?? [];
        view.trace = message.processingTrace ?? [];
        view.latencyMs = message.latencyMs ?? undefined;
      }
    }
    return view;
  }

  /**
   * Abandoned runs are rows nothing is watching any more: the process that
   * owned them restarted or died, so the controller map lost them while the row
   * stayed `running` forever and the sidebar spun on those conversations. The
   * reaper runs once at boot to clear what earlier crashes left behind, then
   * periodically for runs that go stale while this process is alive (a hard
   * kill between the two would otherwise wait for the next restart).
   */
  onModuleInit() {
    void this.reapStaleRuns().catch((error) => {
      this.logger.warn(`stale chat run cleanup failed at startup: ${(error as Error).message}`);
    });
    const intervalMs = Number(process.env.CHAT_RUN_REAP_INTERVAL_MS || 15 * 60 * 1000);
    if (intervalMs > 0) {
      this.reapTimer = setInterval(() => {
        void this.reapStaleRuns().catch(() => { /* retried next tick */ });
        // Same sweep clears out rows past the retention window.
        void this.pruneOldRuns().catch(() => { /* retried next tick */ });
      }, intervalMs);
      this.reapTimer.unref?.();
    }
  }

  onModuleDestroy() {
    if (this.reapTimer) clearInterval(this.reapTimer);
    for (const timer of this.leases.values()) clearTimeout(timer);
    this.leases.clear();
  }

  /**
   * Drop finished runs older than the retention window.
   *
   * Every question writes a row and nothing ever removed one, so the table grew
   * without bound. Only terminal rows are eligible: a `running` row is still
   * being polled, and deleting it would leave the sidebar spinning.
   */
  async pruneOldRuns(retentionMs = Number(process.env.CHAT_RUN_RETENTION_MS || 30 * 24 * 60 * 60 * 1000)): Promise<number> {
    if (!(retentionMs > 0)) return 0;
    const cutoff = new Date(Date.now() - retentionMs);
    const result = await this.prisma.chatRun.deleteMany({
      where: { status: { in: ['completed', 'failed'] }, completedAt: { lt: cutoff } },
    });
    return result.count;
  }

  /**
   * Mark runs abandoned by a crash or restart as failed. Nothing is polling
   * them, so leaving them `running` is what made the sidebar spin forever.
   */
  async reapStaleRuns(olderThanMs = Number(process.env.CHAT_RUN_STALE_MS || 10 * 60 * 1000)): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.chatRun.updateMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      data: { status: 'failed', errorMessage: '服务重启导致回答中断，请重新提问。', completedAt: new Date() },
    });
    return result.count;
  }
}
