import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { getPrismaClient } from '../prisma';

export type ChangeEventType =
  | 'doc_change'
  | 'doc_delete'
  | 'perm_grant'
  | 'perm_revoke'
  | 'org_change'
  | 'role_change'
  | 'schema_change';

export type ResourceType =
  | 'document'
  | 'knowledge_base'
  | 'user'
  | 'role'
  | 'org_node';

@Injectable()
export class BrainOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrainOutboxService.name);
  private prisma = getPrismaClient();
  private dispatchTimer?: ReturnType<typeof setInterval>;
  private dispatching = false;
  private dispatchCursor?: string;

  onModuleInit() {
    this.dispatchTimer = setInterval(() => { void this.dispatchPending(); }, 15_000);
    this.dispatchTimer.unref();
    void this.dispatchPending();
  }

  onModuleDestroy() {
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const events = await this.prisma.brainChangeEvent.findMany({
        where: { status: { in: ['pending', 'processing', 'failed'] }, retryCount: { lt: 10 } },
        orderBy: { id: 'asc' }, take: 100,
        ...(this.dispatchCursor ? { cursor: { id: this.dispatchCursor }, skip: 1 } : {}),
      });
      for (const event of events) {
        const job = await this.compilerQueue.getJob(`outbox-event-${event.id}`);
        if (!job) {
          await this.enqueueEvent(event.id, event.eventType);
        } else {
          const state = await job.getState();
          // Never steal an active or delayed BullMQ lease. BullMQ owns stalled
          // worker detection; replay only terminal jobs with unfinished DB state.
          if (state === 'failed' || state === 'completed') await job.retry(state);
        }
      }
      this.dispatchCursor = events.length === 100 ? events[events.length - 1].id : undefined;
    } catch {
      this.logger.warn('Outbox dispatch unavailable; durable pending events will be retried');
    } finally {
      this.dispatching = false;
    }
  }

  private async enqueueEvent(eventId: string, eventType: string) {
    const isRevoke = eventType === 'perm_revoke' || eventType === 'doc_delete';
    await this.compilerQueue.add('process-outbox-event', { eventId }, {
      jobId: `outbox-event-${eventId}`, priority: isRevoke ? 1 : 3,
      attempts: 3, backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100, removeOnFail: 200,
    });
  }

  constructor(
    @InjectQueue('dirty-compiler-queue') private readonly compilerQueue: Queue,
  ) {}

  /**
   * Persist an event before queue delivery. This standalone API does not make
   * the caller's business mutation atomic with the event; callers needing that
   * guarantee must migrate to a shared database transaction.
   */
  async emitEvent(
    eventType: ChangeEventType,
    resourceType: ResourceType,
    resourceId?: string,
    payload: Record<string, any> = {},
  ): Promise<string> {
    const db: any = this.prisma;
    const event = await db.brainChangeEvent.create({
      data: {
        eventType,
        resourceType,
        resourceId,
        payload: payload || {},
        status: 'pending',
        retryCount: 0,
      },
    });

    this.logger.log(
      `Recorded BrainChangeEvent [${event.id}]: ${eventType} on ${resourceType} ${resourceId || ''}`,
    );

    // 将事件投递到队列中，高优先级处理权限撤销事件
    await this.enqueueEvent(event.id, eventType);

    return event.id;
  }

  /**
   * 记录细粒度运维与 Compile Truth 审计日志
   */
  async logOperation(
    operation: 'sync' | 'dream' | 'scope_compile' | 'synthesize' | 'query',
    data: {
      scopeId?: string;
      phase?: string;
      counts?: Record<string, any>;
      durationMs?: number;
      status?: 'success' | 'warning' | 'failed' | 'skipped';
      error?: string;
    },
  ): Promise<void> {
    const db: any = this.prisma;
    if (!db.brainOperationLog?.create) return;
    try {
      await db.brainOperationLog.create({
        data: {
          operation,
          scopeId: data.scopeId,
          phase: data.phase,
          counts: data.counts || {},
          durationMs: data.durationMs,
          status: data.status || 'success',
          error: data.error,
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to log operation [${operation}]: ${e.message}`);
    }
  }
}
