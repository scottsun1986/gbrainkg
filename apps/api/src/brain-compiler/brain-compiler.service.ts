import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue, QueueEvents } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { PermissionService } from "../permission/permission.service";
import { BrainRepoAdapter } from "@llmwiki/gbrain-adapter";
import { ModelConfigService } from "../model-config.service";
import { createHash } from "node:crypto";
import { readCanonicalDocument } from "./canonical-document";

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
  private gbrain = new BrainRepoAdapter(
    process.env.BRAIN_REPO_BASE_PATH || "/tmp/llmwiki/brain_repos",
  );
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || "/tmp/llmwiki/uploads";
  private readonly maintenanceTimezone =
    process.env.GBRAIN_MAINTENANCE_TZ || "Asia/Shanghai";
  private queueEvents: QueueEvents;

  constructor(
    @InjectQueue("dirty-compiler-queue") private compilerQueue: Queue,
    private readonly permissionService: PermissionService,
    private readonly modelConfigService: ModelConfigService,
  ) {}

  async onModuleInit() {
    await this.modelConfigService.applyRuntimeConfig();
    this.queueEvents = new QueueEvents("dirty-compiler-queue", {
      connection: this.compilerQueue.opts.connection as any,
    });
    await this.queueEvents.waitUntilReady();
    const users = await this.prisma.user.findMany({
      where: { status: "active" },
      select: { id: true, brainRepo: { select: { id: true } } },
    });
    await Promise.all(users.map((user) => this.ensureUserBrainRepo(user.id)));
    if (process.env.GBRAIN_MIGRATE_ON_STARTUP === "1") {
      this.logger.log(
        `Starting one-time GBrain migration for ${users.length} active user(s).`,
      );
      await Promise.all(users.map((user) => this.syncUserBrainRepo(user.id)));
      this.logger.log("One-time GBrain migration completed.");
    }
    // Persisted repeat jobs keep dynamic ACLs fresh and run GBrain's official
    // maintenance cycle without relying on a process-local timer.
    await this.compilerQueue.add(
      "access-reconcile",
      { source: "periodic" },
      {
        jobId: "periodic-access-reconcile",
        repeat: {
          every: Math.max(
            60_000,
            Number(process.env.ACCESS_RECONCILE_INTERVAL_MS || 15 * 60 * 1000),
          ),
        },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    const maintenanceEnabled = process.env.GBRAIN_MAINTENANCE_ENABLED !== "0";
    const maintenancePattern =
      process.env.GBRAIN_MAINTENANCE_CRON || "0 2 * * *";
    // BullMQ's repeat key includes timezone. When timezone was added to an
    // existing deployment, the old timezone-less repeatable job would
    // otherwise remain alongside the new one and execute Dream twice.
    const repeatableJobs = await this.compilerQueue.getRepeatableJobs();
    for (const repeatable of repeatableJobs) {
      if (repeatable.name !== "gbrain-maintenance") continue;
      const isDesired =
        maintenanceEnabled &&
        repeatable.pattern === maintenancePattern &&
        repeatable.tz === this.maintenanceTimezone;
      if (!isDesired) {
        await this.compilerQueue.removeRepeatableByKey(repeatable.key);
        this.logger.log(
          `Removed stale GBrain maintenance repeat job ${repeatable.key}.`,
        );
      }
    }
    if (maintenanceEnabled) {
      await this.compilerQueue.add(
        "gbrain-maintenance",
        {},
        {
          jobId: "nightly-gbrain-maintenance",
          repeat: {
            pattern: maintenancePattern,
            tz: this.maintenanceTimezone,
          },
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: 30,
          removeOnFail: 100,
        },
      );
    }
    // Rebuild the current source membership/materialization immediately after
    // deployment; the repeat job then covers future expiry and drift.
    await this.queueAccessReconciliation();
  }

  async ensureUserBrainRepo(userId: string) {
    await this.modelConfigService.applyRuntimeConfig();
    const existing = await this.prisma.brainRepo.findUnique({
      where: { userId },
    });
    // BrainRepo 保留为旧版数据库兼容记录；真实检索 source 由
    // getUserSourceRefs() 计算，不再为每个用户复制一份完整大脑。
    const sourceRef = await this.gbrain.initializeSource("llmwiki-shared");
    if (existing?.gitRepoUrl === sourceRef) return existing;
    return this.prisma.brainRepo.upsert({
      where: { userId },
      create: { userId, gitRepoUrl: sourceRef, status: "active" },
      update: { gitRepoUrl: sourceRef, status: "active" },
    });
  }

  async syncUserBrainRepo(userId: string) {
    await this.modelConfigService.applyRuntimeConfig();
    const refs = await this.getUserSourceRefs(userId);
    for (const definition of await this.getSourcePlan(userId)) {
      await this.syncSourceDefinition(definition, userId);
    }
    const brainRepo = await this.ensureUserBrainRepo(userId);
    await this.prisma.brainRepo.update({
      where: { id: brainRepo.id },
      data: { lastCompileAt: new Date() },
    });
    this.logger.log(
      `Incrementally synced ${refs.length} GBrain source(s) for user ${userId}.`,
    );
    return brainRepo;
  }

  async syncSourceIncremental(
    sourceKey: string,
    userId: string,
    changedDocIds: string[] = [],
  ) {
    const plan = await this.getSourcePlan(userId);
    let definition = plan.find((item) => item.sourceKey === sourceKey);
    // ACL changes may regroup a KB after the job is queued. Resolve the
    // current source from the document's KB instead of accepting a stale key.
    if (!definition && changedDocIds.length) {
      const changed = await this.prisma.document.findMany({
        where: { id: { in: changedDocIds } },
        select: { kbId: true },
      });
      const kbIds = new Set(changed.map((item) => item.kbId));
      definition = plan.find((item) =>
        item.kbIds.some((kbId) => kbIds.has(kbId)),
      );
    }
    if (!definition)
      throw new Error(
        `No current GBrain source is available for ${changedDocIds.join(",") || sourceKey}.`,
      );
    return this.syncSourceDefinition(definition, userId, changedDocIds);
  }

  /** Sources visible to this user. The database ACL is still authoritative at query time. */
  async getUserSourceRefs(userId: string): Promise<string[]> {
    const definitions = await this.getSourcePlan(userId);
    const refs: string[] = [];
    const db: any = this.prisma as any;
    const desiredSourceIds: string[] = [];
    for (const definition of definitions) {
      const source = await db.brainSource.upsert({
        where: { sourceKey: definition.sourceKey },
        create: {
          sourceKey: definition.sourceKey,
          kind: definition.kind,
          scopeKey: definition.scopeKey,
        },
        update: {
          status: "active",
          kind: definition.kind,
          scopeKey: definition.scopeKey,
        },
      });
      desiredSourceIds.push(source.id);
      await db.brainSourceMember.upsert({
        where: { sourceId_userId: { sourceId: source.id, userId } },
        create: { sourceId: source.id, userId },
        update: {},
      });
      await this.gbrain.initializeSource(definition.sourceKey);
      refs.push(`gbrain://source/${definition.sourceKey}`);
    }
    // Membership is a materialized cache of the current ACL. Remove obsolete
    // rows immediately so revoked grants cannot survive as stale source grants.
    await db.brainSourceMember.deleteMany({
      where: {
        userId,
        ...(desiredSourceIds.length
          ? { sourceId: { notIn: desiredSourceIds } }
          : {}),
      },
    });
    return refs;
  }

  private async getSourcePlan(userId: string): Promise<
    Array<{
      sourceKey: string;
      kind: string;
      scopeKey: string;
      kbIds: string[];
    }>
  > {
    const visibleKbIds =
      await this.permissionService.getVisibleKnowledgeBases(userId);
    const kbs = await this.prisma.knowledgeBase.findMany({
      where: { id: { in: visibleKbIds }, status: "active" },
      select: { id: true, type: true },
    });
    const activeUsers = await this.prisma.user.findMany({
      where: { status: "active" },
      select: { id: true },
    });
    const allAudienceKey = activeUsers
      .map((item) => item.id)
      .sort()
      .join(",");
    const groups = new Map<
      string,
      { sourceKey: string; kind: string; scopeKey: string; kbIds: string[] }
    >();
    for (const kb of kbs) {
      // GBrain supports read isolation at source granularity. Therefore every
      // KB—organization, industry, or personal—is placed in the source for its
      // exact effective audience. KBs with identical audiences share a source.
      const audience = (
        await this.permissionService.getUsersVisibleToKnowledgeBase(kb.id)
      ).sort();
      const scopeKey = audience.join(",") || `kb:${kb.id}`;
      const isShared = Boolean(allAudienceKey) && scopeKey === allAudienceKey;
      const sourceKey = isShared
        ? "llmwiki-shared"
        : `llmwiki-scope-${createHash("sha256").update(scopeKey).digest("hex").slice(0, 16)}`;
      const group = groups.get(sourceKey) || {
        sourceKey,
        kind: isShared ? "shared" : "private",
        scopeKey,
        kbIds: [],
      };
      group.kbIds.push(kb.id);
      groups.set(sourceKey, group);
    }
    return [...groups.values()];
  }

  private async syncSourceDefinition(
    definition: {
      sourceKey: string;
      kind: string;
      scopeKey: string;
      kbIds: string[];
    },
    userId: string,
    changedDocIds: string[] = [],
  ) {
    const db: any = this.prisma as any;
    const source = await db.brainSource.upsert({
      where: { sourceKey: definition.sourceKey },
      create: {
        sourceKey: definition.sourceKey,
        kind: definition.kind,
        scopeKey: definition.scopeKey,
      },
      update: {
        status: "active",
        kind: definition.kind,
        scopeKey: definition.scopeKey,
      },
    });
    await db.brainSourceMember.upsert({
      where: { sourceId_userId: { sourceId: source.id, userId } },
      create: { sourceId: source.id, userId },
      update: {},
    });
    await this.gbrain.initializeSource(definition.sourceKey);

    // A newly parsed document is intentionally marked indexing until this
    // sync succeeds. Include only the explicitly changed indexing documents;
    // normal reconciliation still excludes unfinished documents.
    const desired = await this.prisma.document.findMany({
      where: {
        kbId: { in: definition.kbIds },
        OR: [
          { status: "published" },
          ...(changedDocIds.length
            ? [{ id: { in: changedDocIds }, status: "indexing" }]
            : []),
        ],
      },
      select: { id: true, kbId: true, version: true, updatedAt: true },
    });
    const desiredIds = new Set(desired.map((doc) => doc.id));
    const existing = await db.brainSourceDocument.findMany({
      where: { sourceId: source.id },
      select: { documentId: true, syncedVersion: true, syncedAt: true },
    });
    const existingById = new Map<string, any>(
      existing.map((doc: any) => [doc.documentId, doc] as [string, any]),
    );
    const changedSet = new Set(changedDocIds);
    const materialized = await this.gbrain.isSourceMaterialized(
      `gbrain://source/${definition.sourceKey}`,
    );
    const toSync = desired.filter((doc) => {
      const previous = existingById.get(doc.id);
      return (
        !materialized ||
        changedSet.has(doc.id) ||
        !previous ||
        doc.version > previous.syncedVersion ||
        doc.updatedAt > previous.syncedAt
      );
    });
    if (toSync.length) {
      const documents = await this.prisma.document.findMany({
        where: { id: { in: toSync.map((doc) => doc.id) } },
        include: {
          kb: { select: { name: true, type: true } },
          chunks: {
            orderBy: { ord: "asc" },
            select: {
              content: true,
              charStart: true,
              charEnd: true,
              metadata: true,
            },
          },
        },
      });
      const evidences = await Promise.all(
        documents.map(async (document) => ({
          text: await readCanonicalDocument(
            this.uploadRoot,
            document.id,
            document.chunks,
          ),
          sourceFile: document.title,
          kbId: document.kbId,
          kbName: document.kb.name,
          kbType: document.kb.type,
          topic: document.title.replace(/\.[^.]+$/, ""),
          slug: `docs/${document.id}`,
        })),
      );
      await this.gbrain.ingest(
        `gbrain://source/${definition.sourceKey}`,
        evidences,
      );
      for (const document of documents) {
        await db.brainSourceDocument.upsert({
          where: {
            sourceId_documentId: {
              sourceId: source.id,
              documentId: document.id,
            },
          },
          create: {
            sourceId: source.id,
            documentId: document.id,
            syncedVersion: document.version,
            syncedAt: new Date(),
          },
          update: { syncedVersion: document.version, syncedAt: new Date() },
        });
      }
    }
    const stale = existing.filter(
      (item: any) => !desiredIds.has(item.documentId),
    );
    if (stale.length)
      await this.gbrain.deleteMany(
        `gbrain://source/${definition.sourceKey}`,
        stale.map((item: any) => `docs/${item.documentId}`),
      );
    if (stale.length)
      await db.brainSourceDocument.deleteMany({
        where: {
          sourceId: source.id,
          documentId: { in: stale.map((item: any) => item.documentId) },
        },
      });
    await db.brainSource.update({
      where: { id: source.id },
      data: { lastSyncAt: new Date(), status: "active" },
    });
    return {
      sourceKey: definition.sourceKey,
      synced: toSync.length,
      removed: stale.length,
    };
  }

  /** Durable, queue-triggered reconciliation after organization/role/ACL changes. */
  async reconcileAccess(): Promise<{ users: number; sourcesSynced: number }> {
    const users = await this.prisma.user.findMany({
      where: { status: "active" },
      select: { id: true },
    });
    const syncedSourceKeys = new Set<string>();
    for (const user of users) {
      const plan = await this.getSourcePlan(user.id);
      await this.getUserSourceRefs(user.id);
      for (const definition of plan) {
        if (syncedSourceKeys.has(definition.sourceKey)) continue;
        await this.syncSourceDefinition(definition, user.id);
        syncedSourceKeys.add(definition.sourceKey);
      }
    }
    const db: any = this.prisma as any;
    const emptySources = await db.brainSource.findMany({
      where: { members: { none: {} }, status: "active" },
      select: { id: true },
    });
    if (emptySources.length)
      await db.brainSource.updateMany({
        where: { id: { in: emptySources.map((item: any) => item.id) } },
        data: { status: "archived" },
      });
    return { users: users.length, sourcesSynced: syncedSourceKeys.size };
  }

  async queueAccessReconciliation(): Promise<void> {
    await this.compilerQueue.add(
      "access-reconcile",
      {},
      {
        jobId: "access-reconcile-active",
        priority: CompilePriority.CRITICAL,
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async queueDreamCycle(trigger = "manual") {
    return this.compilerQueue.add(
      "gbrain-maintenance",
      { source: trigger },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
      },
    );
  }

  async onModuleDestroy() {
    await this.queueEvents?.close();
    await this.prisma.$disconnect();
  }

  /**
   * 触发器：知识发布时，将影响面加入 Dirty 队列
   */
  async onKnowledgePublished(
    kbId: string,
    docId: string,
    topics: string[],
  ): Promise<number> {
    this.logger.log(
      `Knowledge published in KB ${kbId}. Calculating affected users...`,
    );

    // 1. 根据当前权限实时计算可见用户，避免发布事件把内容编译给错误的人。
    const visibleUsers =
      await this.permissionService.getUsersVisibleToKnowledgeBase(kbId);
    const publishedDocument = await this.prisma.document.findUnique({
      where: { id: docId },
      select: { version: true },
    });
    const publishVersion = publishedDocument?.version || Date.now();

    // 2. 为每个当前有权阅读的人入队。共享 source 会在队列内自然幂等，
    // 私密 source 则必须分别编译，不能只取 visibleUsers[0]，否则同一份
    // 发布内容可能只进入第一个人的 source。
    const jobs = (
      await Promise.all(
        visibleUsers.map(async (userId) => {
          const sourceKey =
            (await this.getSourcePlan(userId).catch(() => [])).find((item) =>
              item.kbIds.includes(kbId),
            )?.sourceKey || "llmwiki-shared";
          return topics.map((topic) => ({
            name: "compile-job",
            data: {
              userId,
              topicSlug: topic,
              source: "knowledge_publish",
              kbId,
              docIds: [docId],
              sourceKey,
            },
            opts: {
              // 同一用户、文档、主题在短时间内重复发布时保持队列幂等，
              // 不改变最终权限，只减少重复同步。
              jobId: `publish-${userId}-${docId}-v${publishVersion}-${createHash(
                "sha1",
              )
                .update(`${sourceKey}:${topic}`)
                .digest("hex")
                .slice(0, 12)}`,
              priority: CompilePriority.NORMAL,
              attempts: 3,
              backoff: { type: "exponential", delay: 3_000 },
              removeOnComplete: 200,
              removeOnFail: 500,
            },
          }));
        }),
      )
    ).flat();

    if (jobs.length > 0) {
      await this.compilerQueue.addBulk(jobs);
      this.logger.log(`Added ${jobs.length} compile jobs to the queue.`);
    }
    return jobs.length;
  }

  async onKnowledgeDeleted(kbId: string, docId: string) {
    const visibleUsers =
      await this.permissionService.getUsersVisibleToKnowledgeBase(kbId);
    const db: any = this.prisma as any;
    const mappedSources = db.brainSourceDocument?.findMany
      ? await db.brainSourceDocument.findMany({
          where: { documentId: docId },
          select: { source: { select: { sourceKey: true } } },
        })
      : [];
    const sourceKeys = new Set<string>(
      mappedSources.map((item: any) => item.source?.sourceKey).filter(Boolean),
    );
    // 重新根据当前 ACL 计算一次，覆盖尚未物化映射的 source；已撤销权限的
    // 旧映射仍由上面的数据库映射负责清理。
    await Promise.all(
      visibleUsers.map(async (userId) => {
        const sourceKey =
          (await this.getSourcePlan(userId).catch(() => [])).find((item) =>
            item.kbIds.includes(kbId),
          )?.sourceKey;
        if (sourceKey) sourceKeys.add(sourceKey);
      }),
    );
    for (const sourceKey of sourceKeys) {
      await this.gbrain.delete(`gbrain://source/${sourceKey}`, `docs/${docId}`);
      const source = await db.brainSource.findUnique?.({
        where: { sourceKey },
      });
      if (source)
        await db.brainSourceDocument.deleteMany({
          where: { sourceId: source.id, documentId: docId },
        });
      this.logger.log(
        `Removed document ${docId} from GBrain source ${sourceKey}.`,
      );
    }
  }

  /**
   * 懒编译兜底：查询侧发现命中 Dirty 主题时，同步等待编译完成
   */
  async triggerLazyCompileAndWait(
    userId: string,
    topicSlug: string,
  ): Promise<void> {
    this.logger.log(
      `Triggering IMMEDIATE lazy compile for user ${userId}, topic ${topicSlug}`,
    );

    // 插入高优先级任务，并等待完成
    const job = await this.compilerQueue.add(
      "compile-job",
      {
        userId,
        topicSlug,
        source: "lazy",
      },
      { priority: CompilePriority.IMMEDIATE },
    );

    await job.waitUntilFinished(this.queueEvents);
  }

  /**
   * 知识沉淀与一致性维护：Dream Cycle 调度维护任务
   * 检查脏主题、协调文档版本差异、在后台消化编译
   */
  async runDreamCycle(
    userId?: string,
    trigger = "scheduled",
  ): Promise<{ queuedTopics: number; syncedDocs: number; removedDocs: number; status: string }> {
    this.logger.log(
      `Starting Dream Cycle maintenance${userId ? ` for user ${userId}` : " across all active users"}...`,
    );
    let queuedTopics = 0;
    let syncedDocs = 0;
    let removedDocs = 0;
    const sourceResults: Array<Record<string, unknown>> = [];
    const startedAt = Date.now();
    const maintenanceRun = await (this.prisma as any).brainMaintenanceRun.create({
      data: { trigger, status: "running" },
    });

    try {
      const targetUsers = userId
        ? [{ id: userId }]
        : await this.prisma.user.findMany({
            where: { status: "active" },
            select: { id: true },
          });

      const maintainedSources = new Set<string>();
      for (const user of targetUsers) {
        // 1. 同步用户可见的最新知识源
        const plan = await this.getSourcePlan(user.id);
        for (const def of plan) {
          if (!maintainedSources.has(def.sourceKey)) {
            const res = await this.syncSourceDefinition(def, user.id);
            syncedDocs += res.synced;
            removedDocs += res.removed;
            const dream = await this.gbrain.maintain(`gbrain://source/${def.sourceKey}`);
            const gbrainStatus = dream?.status || "completed";
            // GBrain uses both `clean` and `completed` for a successful cycle
            // depending on whether anything changed. Normalize them for the
            // platform audit view while retaining the original status.
            const sourceStatus = gbrainStatus === "partial" ? "partial" : "completed";
            const phaseSummary = Array.isArray(dream?.phases)
              ? dream.phases.map((phase: any) => ({
                  phase: phase.phase,
                  status: phase.status,
                  summary: phase.summary,
                  reason: phase.reason,
                }))
              : [];
            sourceResults.push({
              sourceKey: def.sourceKey,
              kind: def.kind,
              synced: res.synced,
              removed: res.removed,
              status: sourceStatus,
              gbrainStatus,
              phases: phaseSummary,
            });
            maintainedSources.add(def.sourceKey);
          }
        }

        // 2. 清理并编译积压的脏主题
        const brainRepo = await this.prisma.brainRepo.findUnique({
          where: { userId: user.id },
        });
        if (brainRepo) {
          const dirtyTopics = await this.prisma.brainTopic.findMany({
            where: { brainRepoId: brainRepo.id, compileStatus: "dirty" },
          });
          for (const topic of dirtyTopics) {
            await this.compilerQueue.add(
              "compile-job",
              {
                userId: user.id,
                topicSlug: topic.topicSlug,
                source: "dream",
              },
              { priority: CompilePriority.LOW },
            );
            queuedTopics++;
          }
        }
      }
      this.logger.log(
        `Dream Cycle completed: synced ${syncedDocs} doc(s), queued ${queuedTopics} topic(s).`,
      );
      const hasPartial = sourceResults.some((result) => result.status === "partial");
      const status = hasPartial ? "partial" : "completed";
      await (this.prisma as any).brainMaintenanceRun.update({
        where: { id: maintenanceRun.id },
        data: {
          status,
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
          sourcesVisited: sourceResults.length,
          sourcesSucceeded: sourceResults.filter((result) => result.status === "completed").length,
          sourcesPartial: sourceResults.filter((result) => result.status === "partial").length,
          syncedDocs,
          removedDocs,
          queuedTopics,
          sourceResults,
        },
      });
      return { queuedTopics, syncedDocs, removedDocs, status };
    } catch (err: any) {
      this.logger.error(`Dream Cycle error: ${err.message}`);
      await (this.prisma as any).brainMaintenanceRun.update({
        where: { id: maintenanceRun.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
          sourcesVisited: sourceResults.length,
          sourcesSucceeded: sourceResults.filter((result) => result.status === "completed").length,
          sourcesPartial: sourceResults.filter((result) => result.status === "partial").length,
          syncedDocs,
          removedDocs,
          queuedTopics,
          sourceResults,
          errorMessage: String(err?.message || err),
        },
      }).catch((updateError: any) => this.logger.error(`Failed to persist Dream failure: ${updateError.message}`));
      // Do not acknowledge a failed maintenance cycle. BullMQ must retain
      // the failure and apply the configured retry/backoff policy.
      throw err;
    }
  }

  async getDreamTelemetry() {
    const db: any = this.prisma as any;
    const [lastRun, runs, sources, dirtyTopics, queueCounts, failedJobs] = await Promise.all([
      db.brainMaintenanceRun.findFirst({ orderBy: { startedAt: "desc" } }),
      db.brainMaintenanceRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 }),
      db.brainSource.findMany({
        where: { status: "active" },
        include: { _count: { select: { members: true, documents: true } } },
        orderBy: { sourceKey: "asc" },
      }),
      db.brainTopic.count({ where: { compileStatus: "dirty" } }),
      this.compilerQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
      this.compilerQueue.getJobs(["failed"], 0, 49),
    ]);
    const lastStartedAt = lastRun?.startedAt ? new Date(lastRun.startedAt).getTime() : 0;
    const staleAfterMs = Math.max(90 * 60 * 1000, Number(process.env.GBRAIN_MAINTENANCE_STALE_MS || 36 * 60 * 60 * 1000));
    const health = process.env.GBRAIN_MAINTENANCE_ENABLED === "0"
      ? "disabled"
      : !lastRun
      ? "unknown"
      : lastRun.status === "failed"
      ? "failed"
      : lastRun.status === "partial"
      ? "degraded"
      : Date.now() - lastStartedAt > staleAfterMs
      ? "stale"
      : "healthy";
    return {
      enabled: process.env.GBRAIN_MAINTENANCE_ENABLED !== "0",
      cron: process.env.GBRAIN_MAINTENANCE_CRON || "0 2 * * *",
      timezone: this.maintenanceTimezone,
      intervalMinutes: 24 * 60,
      health,
      lastRun,
      runs,
      sources: sources.map((source: any) => ({
        sourceKey: source.sourceKey,
        kind: source.kind,
        status: source.status,
        scopeKey: source.scopeKey,
        lastSyncAt: source.lastSyncAt,
        members: source._count.members,
        documents: source._count.documents,
      })),
      dirtyTopics,
      queueCounts,
      maintenanceFailures: failedJobs
        .filter((job: any) => job.name === "gbrain-maintenance")
        .map((job: any) => ({
          id: job.id,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
        })),
    };
  }
}
