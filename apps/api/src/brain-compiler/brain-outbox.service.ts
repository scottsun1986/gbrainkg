import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';

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
export class BrainOutboxService {
  private readonly logger = new Logger(BrainOutboxService.name);
  private prisma = new PrismaClient();

  constructor(
    @InjectQueue('dirty-compiler-queue') private readonly compilerQueue: Queue,
  ) {}

  /**
   * 事务可靠地记录变更事件，并推入异步消费队列
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
    const isRevoke = eventType === 'perm_revoke' || eventType === 'doc_delete';
    await this.compilerQueue.add(
      'process-outbox-event',
      { eventId: event.id },
      {
        jobId: `outbox-event-${event.id}`,
        priority: isRevoke ? 1 : 3, // 1: CRITICAL, 3: HIGH
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );

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
