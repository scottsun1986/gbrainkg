import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { getPrismaClient } from '../prisma';

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
export class ChatRunService {
  private readonly logger = new Logger(ChatRunService.name);
  private readonly prisma = getPrismaClient();
  /** In-process cancellation handles, keyed by run id. */
  private readonly controllers = new Map<string, AbortController>();

  async start(conversationId: string, userId: string): Promise<ChatRunView> {
    const controller = new AbortController();
    const run = await this.prisma.chatRun.create({
      data: { conversationId, userId, status: 'running', stage: 'queued' },
      select: { id: true, conversationId: true },
    });
    this.controllers.set(run.id, controller);
    return { runId: run.id, conversationId: run.conversationId, status: 'running', stage: 'queued' };
  }

  /** The signal a run's pipeline should observe, or undefined once it settled. */
  signalFor(runId: string): AbortSignal | undefined {
    return this.controllers.get(runId)?.signal;
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

  async complete(runId: string, messageId: string): Promise<void> {
    this.controllers.delete(runId);
    try {
      await this.prisma.chatRun.updateMany({
        where: { id: runId },
        data: { status: 'completed', stage: 'persisting', messageId, completedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(`chat run ${runId}: completion not recorded: ${(error as Error).message}`);
    }
  }

  async fail(runId: string, message: string): Promise<void> {
    this.controllers.delete(runId);
    try {
      await this.prisma.chatRun.updateMany({
        where: { id: runId },
        data: { status: 'failed', errorMessage: message.slice(0, 2000), completedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(`chat run ${runId}: failure not recorded: ${(error as Error).message}`);
    }
  }

  /** Best-effort cancel. Only the process that started the run can abort it. */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
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
        select: { id: true, content: true, citationsSummary: true, processingTrace: true, latencyMs: true },
      });
      if (message) {
        view.messageId = message.id;
        view.answer = message.content;
        view.citations = message.citationsSummary ?? [];
        view.trace = message.processingTrace ?? [];
        view.latencyMs = message.latencyMs ?? undefined;
      }
    }
    return view;
  }

  /**
   * Abandon runs left `running` by a process restart. Nothing is watching them
   * any more, so without this the sidebar would spin forever on those
   * conversations. Called once at bootstrap.
   */
  async reapStaleRuns(olderThanMs = 10 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.chatRun.updateMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      data: { status: 'failed', errorMessage: '服务重启导致回答中断，请重新提问。', completedAt: new Date() },
    });
    return result.count;
  }
}