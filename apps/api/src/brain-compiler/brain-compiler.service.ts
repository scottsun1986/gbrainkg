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

import { BrainScopeService } from "./brain-scope.service";
import { BrainOutboxService } from "./brain-outbox.service";

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
    private readonly scopeService: BrainScopeService,
    private readonly outboxService: BrainOutboxService,
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
  async reconcileAccess(): Promise<{ users: number; sourcesSynced: number; scopesReconciled: number }> {
    const users = await this.prisma.user.findMany({
      where: { status: "active" },
      select: { id: true },
    });
    const syncedSourceKeys = new Set<string>();
    const reconciledScopeIds = new Set<string>();

    for (const user of users) {
      const plan = await this.getSourcePlan(user.id);
      await this.getUserSourceRefs(user.id);
      for (const definition of plan) {
        if (syncedSourceKeys.has(definition.sourceKey)) continue;
        await this.syncSourceDefinition(definition, user.id);
        syncedSourceKeys.add(definition.sourceKey);
      }
      // 计算并更新该用户的权限 Scope
      const scopeRes = await this.scopeService.resolveUserScope(user.id);
      reconciledScopeIds.add(scopeRes.scopeId);

      // 对于 eager 策略的 Scope，安排派生层编译
      if (scopeRes.strategy === "eager") {
        await this.compilerQueue.add(
          "scope-derived-compile",
          { scopeId: scopeRes.scopeId },
          {
            jobId: `scope-compile-${scopeRes.scopeId}`,
            priority: CompilePriority.NORMAL,
            removeOnComplete: true,
            removeOnFail: 50,
          },
        );
      }
    }

    const db: any = this.prisma as any;
    const emptySources = await db.brainSource.findMany({
      where: { members: { none: {} }, status: "active" },
      select: { id: true },
    });
    if (emptySources.length) {
      await db.brainSource.updateMany({
        where: { id: { in: emptySources.map((item: any) => item.id) } },
        data: { status: "archived" },
      });
    }

    return {
      users: users.length,
      sourcesSynced: syncedSourceKeys.size,
      scopesReconciled: reconciledScopeIds.size,
    };
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

    const visibleUsers =
      await this.permissionService.getUsersVisibleToKnowledgeBase(kbId);
    const publishedDocument = await this.prisma.document.findUnique({
      where: { id: docId },
      select: { version: true },
    });
    const publishVersion = publishedDocument?.version || Date.now();

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
   * 双级 Dream Cycle 维护：
   * Tier 1 (Source Dream): 原始知识源的索引、Embedding、结构自愈与 Lint
   * Tier 2 (Scope Dream): 用户可见权限 Scope 内的跨源宏观综合与派生智能维护
   */
  async runDreamCycle(
    userId?: string,
    trigger = "scheduled",
  ): Promise<{
    queuedTopics: number;
    syncedDocs: number;
    removedDocs: number;
    status: string;
    scopesCompiled: number;
  }> {
    this.logger.log(
      `Starting Two-Tier Dream Cycle maintenance${userId ? ` for user ${userId}` : " across all active users"}...`,
    );
    let queuedTopics = 0;
    let syncedDocs = 0;
    let removedDocs = 0;
    let scopesCompiled = 0;
    const sourceResults: Array<Record<string, unknown>> = [];
    const startedAt = Date.now();
    const db: any = this.prisma as any;
    const maintenanceRun = await db.brainMaintenanceRun.create({
      data: { trigger, status: "running" },
    });

    try {
      const targetUsers = userId
        ? [{ id: userId }]
        : await this.prisma.user.findMany({
            where: { status: "active" },
            select: { id: true },
          });

      // === Tier 1: Source Dream (原始 Source 确定性维护) ===
      const maintainedSources = new Set<string>();
      for (const user of targetUsers) {
        const plan = await this.getSourcePlan(user.id);
        for (const def of plan) {
          if (!maintainedSources.has(def.sourceKey)) {
            const res = await this.syncSourceDefinition(def, user.id);
            syncedDocs += res.synced;
            removedDocs += res.removed;
            const dream = await this.gbrain.maintain(`gbrain://source/${def.sourceKey}`);
            const gbrainStatus = dream?.status || "completed";
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
      }

      // === Tier 2: Scope Dream (权限 Scope 跨源综合与派生智能维护) ===
      const activeScopes = await db.brainScope.findMany({
        where: { status: "active" },
      });
      for (const scope of activeScopes) {
        try {
          await this.scopeService.compileScopeDerived(scope.id);
          scopesCompiled++;
        } catch (e: any) {
          this.logger.warn(`Failed Scope Dream for ${scope.fingerprint}: ${e.message}`);
        }
      }

      this.logger.log(
        `Two-Tier Dream Cycle completed: synced ${syncedDocs} doc(s), compiled ${scopesCompiled} scope(s).`,
      );
      const hasPartial = sourceResults.some((result) => result.status === "partial");
      const status = hasPartial ? "partial" : "completed";
      await db.brainMaintenanceRun.update({
        where: { id: maintenanceRun.id },
        data: {
          status,
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
          sourcesVisited: sourceResults.length,
          sourcesSucceeded: sourceResults.filter((result: any) => result.status === "completed").length,
          sourcesPartial: sourceResults.filter((result: any) => result.status === "partial").length,
          syncedDocs,
          removedDocs,
          queuedTopics,
          sourceResults,
        },
      });
      return { queuedTopics, syncedDocs, removedDocs, status, scopesCompiled };
    } catch (err: any) {
      this.logger.error(`Dream Cycle error: ${err.message}`);
      await db.brainMaintenanceRun.update({
        where: { id: maintenanceRun.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
          sourcesVisited: sourceResults.length,
          sourcesSucceeded: sourceResults.filter((result: any) => result.status === "completed").length,
          sourcesPartial: sourceResults.filter((result: any) => result.status === "partial").length,
          syncedDocs,
          removedDocs,
          queuedTopics,
          sourceResults,
          errorMessage: String(err?.message || err),
        },
      }).catch((updateError: any) => this.logger.error(`Failed to persist Dream failure: ${updateError.message}`));
      throw err;
    }
  }

  async getDreamTelemetry() {
    const db: any = this.prisma as any;
    const [lastRun, runs, sources, scopes, derivedCount, outboxPending, opLogs, dirtyTopics, queueCounts, failedJobs] = await Promise.all([
      db.brainMaintenanceRun.findFirst({ orderBy: { startedAt: "desc" } }),
      db.brainMaintenanceRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 }),
      db.brainSource.findMany({
        where: { status: "active" },
        include: { _count: { select: { members: true, documents: true } } },
        orderBy: { sourceKey: "asc" },
      }),
      db.brainScope.findMany({
        where: { status: "active" },
        include: { _count: { select: { members: true, derivedPages: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.brainDerivedPage.count(),
      db.brainChangeEvent.count({ where: { status: "pending" } }),
      db.brainOperationLog.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
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
      scopes: scopes.map((s: any) => ({
        id: s.id,
        fingerprint: s.fingerprint,
        name: s.name,
        strategy: s.strategy,
        status: s.status,
        aclEpoch: s.aclEpoch,
        knowledgeEpoch: s.knowledgeEpoch,
        lastCompileAt: s.lastCompileAt,
        membersCount: s._count.members,
        derivedCount: s._count.derivedPages,
      })),
      derivedPagesCount: derivedCount,
      outboxPendingEvents: outboxPending,
      recentOperationLogs: opLogs,
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
