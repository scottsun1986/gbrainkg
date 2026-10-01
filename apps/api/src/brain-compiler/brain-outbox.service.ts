import { runAsService } from '../db/service-principal';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { getPrismaClient } from '../prisma';

export type ChangeEventType =
  | 'doc_change'
  | 'doc_delete'
  | 'doc_acl_change'
  | 'enrichment_request'
  | 'aux_enrichment_request'
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
    this.dispatchTimer = setInterval(() => { void this.dispatchPending(); }, 5_000);
    this.dispatchTimer.unref();
    void this.dispatchPending();
  }

  onModuleDestroy() {
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
  }

  async dispatchPending(): Promise<void> { return runAsService('outbox-dispatch', () => this.dispatchInternal()); }

  private async dispatchInternal(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const coreLimit = Math.max(1, Number(process.env.ENRICHMENT_QUEUE_MAX_WAITING || 500));
      const auxLimit = Math.max(1, Number(process.env.AUX_ENRICHMENT_QUEUE_MAX_WAITING || 100));
      const counts = await Promise.all([this.enrichmentQueue, this.auxiliaryQueue].map(async (queue) =>
        typeof queue?.getJobCounts === 'function'
          ? await queue.getJobCounts('waiting', 'delayed') : { waiting: 0, delayed: 0 }));
      let coreQueued = Number(counts[0].waiting || 0) + Number(counts[0].delayed || 0);
      let auxQueued = Number(counts[1].waiting || 0) + Number(counts[1].delayed || 0);
      const events = await this.prisma.brainChangeEvent.findMany({
        where: { status: { in: ['pending', 'processing', 'failed'] }, retryCount: { lt: 10 } },
        orderBy: { id: 'asc' }, take: 100,
        ...(this.dispatchCursor ? { cursor: { id: this.dispatchCursor }, skip: 1 } : {}),
      });
      for (const event of events) {
        try {
          const isEnrichment = event.eventType === 'enrichment_request';
          const isAuxiliary = event.eventType === 'aux_enrichment_request';
          const queue = isAuxiliary ? this.auxiliaryQueue : isEnrichment ? this.enrichmentQueue : this.compilerQueue;
          const jobId = isAuxiliary ? `aux-outbox-${event.id}` : isEnrichment ? `enrichment-outbox-${event.id}` : `outbox-event-${event.id}`;
          const job = await queue.getJob(jobId);
          if (!job) {
            if (isEnrichment && coreQueued >= coreLimit) continue;
            if (isAuxiliary && auxQueued >= auxLimit) continue;
            await this.enqueueEvent(event.id, event.eventType, event.resourceId, event.payload);
            if (isEnrichment) coreQueued += 1;
            if (isAuxiliary) auxQueued += 1;
          } else {
            const state = await job.getState();
            // Never steal an active or delayed BullMQ lease. BullMQ owns stalled
            // worker detection; replay only terminal jobs with unfinished DB state.
            if (state === 'failed' || state === 'completed') {
              if (isEnrichment && coreQueued >= coreLimit) continue;
              if (isAuxiliary && auxQueued >= auxLimit) continue;
              await job.retry(state);
              if (isEnrichment) coreQueued += 1;
              if (isAuxiliary) auxQueued += 1;
            }
          }
        } catch (error) {
          // One malformed event or terminal-job race must not starve later
          // events (including permission revocations) in this batch.
          this.logger.warn(`Outbox event ${event.id} dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.dispatchCursor = events.length === 100 ? events[events.length - 1].id : undefined;
    } catch {
      this.logger.warn('Outbox dispatch unavailable; durable pending events will be retried');
    } finally {
      this.dispatching = false;
    }
  }

  private async enqueueEvent(eventId: string, eventType: string, resourceId?: string | null, payload?: any) {
    const isRevoke = eventType === 'perm_revoke' || eventType === 'doc_delete' || eventType === 'doc_acl_change';
    if (eventType === 'enrichment_request' || eventType === 'aux_enrichment_request') {
      if (!resourceId || !payload?.kbId || typeof payload?.version !== 'number') {
        throw new Error(`Invalid enrichment outbox event ${eventId}`);
      }
      const auxiliary = eventType === 'aux_enrichment_request';
      await (auxiliary ? this.auxiliaryQueue : this.enrichmentQueue).add(auxiliary ? 'augment-document' : 'enrich-from-outbox', {
        documentId: resourceId,
        kbId: payload.kbId,
        expectedVersion: payload.version,
        ...(payload.versionId ? { versionId: payload.versionId } : {}),
        ...(payload.generationAction ? { generationAction: payload.generationAction, generationId: payload.generationId } : {}),
        outboxEventId: eventId,
      }, {
        jobId: `${auxiliary ? 'aux' : 'enrichment'}-outbox-${eventId}`,
        attempts: Number(process.env.ENRICHMENT_ATTEMPTS || 3),
        backoff: { type: 'exponential', delay: Number(process.env.ENRICHMENT_BACKOFF_MS || 30_000) },
        removeOnComplete: 500,
        removeOnFail: 1000,
      });
      return;
    }
    await this.compilerQueue.add('process-outbox-event', { eventId }, {
      jobId: `outbox-event-${eventId}`, priority: isRevoke ? 1 : 3,
      attempts: 3, backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100, removeOnFail: 200,
    });
  }

  constructor(
    @InjectQueue('dirty-compiler-queue') private readonly compilerQueue: Queue,
    @InjectQueue('enrichment-queue') private readonly enrichmentQueue: Queue,
    @InjectQueue('aux-enrichment-queue') private readonly auxiliaryQueue: Queue,
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
    await this.enqueueEvent(event.id, eventType, resourceId, payload);

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
