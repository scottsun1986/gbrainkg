import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { PermissionService } from '../permission/permission.service';
import { BrainRepoAdapter } from '@llmwiki/gbrain-adapter';
import { ModelConfigService } from '../model-config.service';
import { createHash } from 'node:crypto';

export enum CompilePriority {
  CRITICAL = 1, // 权限撤销
  IMMEDIATE = 2, // 懒编译
  HIGH = 3, // 调岗
  NORMAL = 4, // 知识发布
  LOW = 5, // Dream Cycle
}

@Injectable()
export class BrainCompilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrainCompilerService.name);
  private prisma = new PrismaClient();
  private gbrain = new BrainRepoAdapter(process.env.BRAIN_REPO_BASE_PATH || '/tmp/llmwiki/brain_repos');
  private queueEvents: QueueEvents;

  constructor(
    @InjectQueue('dirty-compiler-queue') private compilerQueue: Queue,
    private readonly permissionService: PermissionService,
    private readonly modelConfigService: ModelConfigService,
  ) {}

  async onModuleInit() {
    await this.modelConfigService.applyRuntimeConfig();
    this.queueEvents = new QueueEvents('dirty-compiler-queue', {
      connection: this.compilerQueue.opts.connection as any,
    });
    await this.queueEvents.waitUntilReady();
    const users = await this.prisma.user.findMany({ where: { status: 'active' }, select: { id: true, brainRepo: { select: { id: true } } } });
    await Promise.all(users.map((user) => this.ensureUserBrainRepo(user.id)));
    if (process.env.GBRAIN_MIGRATE_ON_STARTUP === '1') {
      this.logger.log(`Starting one-time GBrain migration for ${users.length} active user(s).`);
      await Promise.all(users.map((user) => this.syncUserBrainRepo(user.id)));
      this.logger.log('One-time GBrain migration completed.');
    }
  }

  async ensureUserBrainRepo(userId: string) {
    await this.modelConfigService.applyRuntimeConfig();
    const existing = await this.prisma.brainRepo.findUnique({ where: { userId } });
    // BrainRepo 保留为旧版数据库兼容记录；真实检索 source 由
    // getUserSourceRefs() 计算，不再为每个用户复制一份完整大脑。
    const sourceRef = await this.gbrain.initializeSource('llmwiki-shared');
    if (existing?.gitRepoUrl === sourceRef) return existing;
    return this.prisma.brainRepo.upsert({
      where: { userId },
      create: { userId, gitRepoUrl: sourceRef, status: 'active' },
      update: { gitRepoUrl: sourceRef, status: 'active' },
    });
  }

  async syncUserBrainRepo(userId: string) {
    await this.modelConfigService.applyRuntimeConfig();
    const refs = await this.getUserSourceRefs(userId);
    for (const definition of await this.getSourcePlan(userId)) {
      await this.syncSourceDefinition(definition, userId);
    }
    const brainRepo = await this.ensureUserBrainRepo(userId);
    await this.prisma.brainRepo.update({ where: { id: brainRepo.id }, data: { lastCompileAt: new Date() } });
    this.logger.log(`Incrementally synced ${refs.length} GBrain source(s) for user ${userId}.`);
    return brainRepo;
  }

  async syncSourceIncremental(sourceKey: string, userId: string, changedDocIds: string[] = []) {
    const definition = (await this.getSourcePlan(userId)).find((item) => item.sourceKey === sourceKey);
    if (!definition) return { sourceKey, synced: 0, removed: 0 };
    return this.syncSourceDefinition(definition, userId, changedDocIds);
  }

  /** Sources visible to this user. The database ACL is still authoritative at query time. */
  async getUserSourceRefs(userId: string): Promise<string[]> {
    const definitions = await this.getSourcePlan(userId);
    const refs: string[] = [];
    const db: any = this.prisma as any;
    for (const definition of definitions) {
      const source = await db.brainSource.upsert({
        where: { sourceKey: definition.sourceKey },
        create: { sourceKey: definition.sourceKey, kind: definition.kind, scopeKey: definition.scopeKey },
        update: { status: 'active', kind: definition.kind, scopeKey: definition.scopeKey },
      });
      await db.brainSourceMember.upsert({ where: { sourceId_userId: { sourceId: source.id, userId } }, create: { sourceId: source.id, userId }, update: {} });
      await this.gbrain.initializeSource(definition.sourceKey);
      refs.push(`gbrain://source/${definition.sourceKey}`);
    }
    return refs;
  }

  private async getSourcePlan(userId: string): Promise<Array<{ sourceKey: string; kind: string; scopeKey: string; kbIds: string[] }>> {
    const visibleKbIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const kbs = await this.prisma.knowledgeBase.findMany({ where: { id: { in: visibleKbIds }, status: 'active' }, select: { id: true, type: true } });
    const plan: Array<{ sourceKey: string; kind: string; scopeKey: string; kbIds: string[] }> = [];
    // One shared source is deliberately reused by organization/industry KBs.
    // Industry visibility is still enforced by the DB query filter in ChatService.
    const sharedKbIds = kbs.filter((kb) => kb.type !== 'personal').map((kb) => kb.id);
    if (sharedKbIds.length) {
      const allShared = await this.prisma.knowledgeBase.findMany({ where: { type: { not: 'personal' }, status: 'active' }, select: { id: true } });
      plan.push({ sourceKey: 'llmwiki-shared', kind: 'shared', scopeKey: 'shared', kbIds: allShared.map((kb) => kb.id) });
    }

    const privateGroups = new Map<string, string[]>();
    for (const kb of kbs.filter((item) => item.type === 'personal')) {
      // The audience set is the permission group. Today personal libraries have
      // one member; this remains correct if private ACL subjects are added later.
      const audience = (await this.permissionService.getUsersVisibleToKnowledgeBase(kb.id)).sort();
      const scopeKey = audience.join(',') || `kb:${kb.id}`;
      // GBrain source IDs are limited to 32 chars.
      const sourceKey = `llmwiki-private-${createHash('sha256').update(scopeKey).digest('hex').slice(0, 16)}`;
      privateGroups.set(sourceKey, [...(privateGroups.get(sourceKey) || []), kb.id]);
    }
    for (const [sourceKey, kbIds] of privateGroups) plan.push({ sourceKey, kind: 'private', scopeKey: sourceKey, kbIds });
    return plan;
  }

  private async syncSourceDefinition(definition: { sourceKey: string; kind: string; scopeKey: string; kbIds: string[] }, userId: string, changedDocIds: string[] = []) {
    const db: any = this.prisma as any;
    const source = await db.brainSource.upsert({
      where: { sourceKey: definition.sourceKey },
      create: { sourceKey: definition.sourceKey, kind: definition.kind, scopeKey: definition.scopeKey },
      update: { status: 'active', kind: definition.kind, scopeKey: definition.scopeKey },
    });
    await db.brainSourceMember.upsert({ where: { sourceId_userId: { sourceId: source.id, userId } }, create: { sourceId: source.id, userId }, update: {} });
    await this.gbrain.initializeSource(definition.sourceKey);

    // A newly parsed document is intentionally marked indexing until this
    // sync succeeds. Include only the explicitly changed indexing documents;
    // normal reconciliation still excludes unfinished documents.
    const desired = await this.prisma.document.findMany({
      where: {
        kbId: { in: definition.kbIds },
        OR: [
          { status: 'published' },
          ...(changedDocIds.length ? [{ id: { in: changedDocIds }, status: 'indexing' }] : []),
        ],
      },
      select: { id: true, kbId: true, version: true, updatedAt: true },
    });
    const desiredIds = new Set(desired.map((doc) => doc.id));
    const existing = await db.brainSourceDocument.findMany({ where: { sourceId: source.id }, select: { documentId: true, syncedVersion: true, syncedAt: true } });
    const existingById = new Map<string, any>(existing.map((doc: any) => [doc.documentId, doc] as [string, any]));
    const changedSet = new Set(changedDocIds);
    const toSync = desired.filter((doc) => {
      const previous = existingById.get(doc.id);
      return changedSet.has(doc.id) || !previous || doc.version > previous.syncedVersion || doc.updatedAt > previous.syncedAt;
    });
    if (toSync.length) {
      const documents = await this.prisma.document.findMany({ where: { id: { in: toSync.map((doc) => doc.id) } }, include: { chunks: { orderBy: { ord: 'asc' }, select: { content: true } } } });
      for (const document of documents) {
        const evidences = document.chunks.map((chunk) => ({ text: chunk.content, kbId: document.kbId, topic: document.title.replace(/\.[^.]+$/, ''), slug: `docs/${document.id}` }));
        await this.gbrain.ingest(`gbrain://source/${definition.sourceKey}`, evidences);
        await db.brainSourceDocument.upsert({ where: { sourceId_documentId: { sourceId: source.id, documentId: document.id } }, create: { sourceId: source.id, documentId: document.id, syncedVersion: document.version, syncedAt: new Date() }, update: { syncedVersion: document.version, syncedAt: new Date() } });
      }
    }
    const stale = existing.filter((item: any) => !desiredIds.has(item.documentId));
    for (const item of stale) await this.gbrain.delete(`gbrain://source/${definition.sourceKey}`, `docs/${item.documentId}`);
    if (stale.length) await db.brainSourceDocument.deleteMany({ where: { sourceId: source.id, documentId: { in: stale.map((item: any) => item.documentId) } } });
    await db.brainSource.update({ where: { id: source.id }, data: { lastSyncAt: new Date(), status: 'active' } });
    return { sourceKey: definition.sourceKey, synced: toSync.length, removed: stale.length };
  }

  async onModuleDestroy() {
    await this.queueEvents?.close();
    await this.prisma.$disconnect();
  }

  /**
   * 触发器：知识发布时，将影响面加入 Dirty 队列
   */
  async onKnowledgePublished(kbId: string, docId: string, topics: string[]): Promise<number> {
    this.logger.log(`Knowledge published in KB ${kbId}. Calculating affected users...`);
    
    // 1. 根据当前权限实时计算可见用户，避免发布事件把内容编译给错误的人。
    const visibleUsers = await this.permissionService.getUsersVisibleToKnowledgeBase(kbId);

    // 2. 批量入队 Dirty Job
    const sourceKey = (await this.getSourcePlan(visibleUsers[0] || '').catch(() => [])).find((item) => item.kbIds.includes(kbId))?.sourceKey || 'llmwiki-shared';
    const jobs = [];
    for (const userId of visibleUsers.slice(0, 1)) {
      for (const topic of topics) {
        // 合并去重逻辑通常由 BullMQ 的 jobId 唯一性保证 (例如 userId_topic_hash)
        jobs.push({
          name: 'compile-job',
          data: {
            userId,
            topicSlug: topic,
            source: 'knowledge_publish',
            docIds: [docId],
            sourceKey,
          },
          opts: {
            priority: CompilePriority.NORMAL,
          jobId: `dirty_${userId}_${encodeURIComponent(topic)}_${docId}` // 同一文档幂等，后续新文档继续触发编译
          }
        });
      }
    }

    if (jobs.length > 0) {
      await this.compilerQueue.addBulk(jobs);
      this.logger.log(`Added ${jobs.length} compile jobs to the queue.`);
    }
    return jobs.length;
  }

  async onKnowledgeDeleted(kbId: string, docId: string) {
    const visibleUsers = await this.permissionService.getUsersVisibleToKnowledgeBase(kbId);
    const sourceKey = (await this.getSourcePlan(visibleUsers[0] || '').catch(() => [])).find((item) => item.kbIds.includes(kbId))?.sourceKey || 'llmwiki-shared';
    await this.gbrain.delete(`gbrain://source/${sourceKey}`, `docs/${docId}`);
    const db: any = this.prisma as any;
    const source = await db.brainSource.findUnique?.({ where: { sourceKey } });
    if (source) await db.brainSourceDocument.deleteMany({ where: { sourceId: source.id, documentId: docId } });
    this.logger.log(`Removed document ${docId} from GBrain source ${sourceKey}.`);
  }

  /**
   * 懒编译兜底：查询侧发现命中 Dirty 主题时，同步等待编译完成
   */
  async triggerLazyCompileAndWait(userId: string, topicSlug: string): Promise<void> {
    this.logger.log(`Triggering IMMEDIATE lazy compile for user ${userId}, topic ${topicSlug}`);
    
    // 插入高优先级任务，并等待完成
    const job = await this.compilerQueue.add('compile-job', {
      userId,
      topicSlug,
      source: 'lazy'
    }, { priority: CompilePriority.IMMEDIATE });
    
    await job.waitUntilFinished(this.queueEvents);
  }
}
