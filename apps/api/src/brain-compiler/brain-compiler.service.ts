import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  Optional,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue, QueueEvents } from "bullmq";
import { getPrismaClient } from "../prisma";
import { PermissionService } from "../permission/permission.service";
import { BrainRepoAdapter } from "@llmwiki/gbrain-adapter";
import { ModelConfigService } from "../model-config.service";
import { createHash } from "node:crypto";
import { readCanonicalDocument } from "./canonical-document";
import { sourceKeyForKnowledgeBase } from "./brain-source";

import { BrainScopeService } from "./brain-scope.service";
import { BrainOutboxService } from "./brain-outbox.service";
import { BrainBackupService } from "./brain-backup.service";
import { getSharedBrainRepoAdapter } from "./brain-adapter.provider";

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
  private prisma = getPrismaClient();
  private gbrain: BrainRepoAdapter;
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
    @Optional() @Inject('BRAIN_REPO_ADAPTER') gbrainAdapter?: BrainRepoAdapter,
    @Optional() private readonly backupService?: BrainBackupService,
  ) {
    this.gbrain = gbrainAdapter ?? getSharedBrainRepoAdapter();
  }

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
    // Bounded fan-out: an unbounded Promise.all over a large user base (each
    // call doing its own model-config refresh + DB upsert) exhausted the Prisma
    // connection pool and hung module init, so the HTTP listener never bound.
    const initConcurrency = Math.max(1, Number(process.env.BRAIN_REPO_INIT_CONCURRENCY || 16));
    for (let i = 0; i < users.length; i += initConcurrency) {
      await Promise.all(
        users.slice(i, i + initConcurrency).map((user) => this.ensureUserBrainRepo(user.id)),
      );
    }
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
    // Runtime model config is applied once during module init (and on demand
    // elsewhere); refreshing it per user here multiplied by the whole user base
    // and was a major startup hazard.
    const existing = await this.prisma.brainRepo.findUnique({
      where: { userId },
    });
    // BrainRepo 保留为旧版数据库兼容记录；真实检索 source 由
    // getUserSourceRefs() 计算，不再为每个用户复制一份完整大脑。
    const userRef = `gbrain://user/${userId}`;
    if (existing?.gitRepoUrl === userRef) return existing;
    return this.prisma.brainRepo.upsert({
      where: { userId },
      create: { userId, gitRepoUrl: userRef, status: "active" },
      update: { gitRepoUrl: userRef, status: "active" },
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

    const existingSources: Array<{ id: string; sourceKey: string }> =
      await db.brainSource.findMany({
        where: { sourceKey: { in: definitions.map((d) => d.sourceKey) } },
        select: { id: true, sourceKey: true },
      });
    const existingMap = new Map(existingSources.map((s) => [s.sourceKey, s.id]));

    const existingMembers: Array<{ sourceId: string }> =
      await db.brainSourceMember.findMany({
        where: {
          userId,
          sourceId: { in: existingSources.map((s) => s.id) },
        },
        select: { sourceId: true },
      });
    const existingMemberSet = new Set(existingMembers.map((m) => m.sourceId));

    for (const definition of definitions) {
      let sourceId = existingMap.get(definition.sourceKey);
      if (!sourceId) {
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
        sourceId = source.id;
        existingMap.set(definition.sourceKey, sourceId);
        await this.gbrain.initializeSource(definition.sourceKey);
      }
      desiredSourceIds.push(sourceId);
      if (!existingMemberSet.has(sourceId)) {
        await db.brainSourceMember.upsert({
          where: { sourceId_userId: { sourceId, userId } },
          create: { sourceId, userId },
          update: {},
        });
        existingMemberSet.add(sourceId);
      }
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

  /**
   * Return only the sources behind the knowledge bases selected for a query.
   * Source identity is content-based (one KB = one source); access is still
   * evaluated from the database for every request.
   */
  async getUserSourceRefsForKnowledgeBases(
    userId: string,
    knowledgeBaseIds: string[],
  ): Promise<string[]> {
    const requested = new Set(knowledgeBaseIds);
    const plan = await this.getSourcePlan(userId);
    const selected = plan.filter((definition) =>
      definition.kbIds.some((kbId) => requested.has(kbId)),
    );
    if (!selected.length) return [];

    const activeDocKbIds = new Set(
      (
        await this.prisma.document.findMany({
          where: { kbId: { in: knowledgeBaseIds }, status: "published" },
          select: { kbId: true },
          distinct: ["kbId"],
        })
      ).map((d) => d.kbId),
    );
    const relevantSelected = selected.filter((definition) =>
      definition.kbIds.some((kbId) => activeDocKbIds.has(kbId)),
    );
    const effectiveSelected = relevantSelected.length > 0 ? relevantSelected : selected;

    // Materialize memberships before returning the references. This keeps the
    // DB representation in sync with current ACLs and makes revocation
    // auditable, while the query itself remains limited to the selected set.
    await this.getUserSourceRefs(userId);
    return effectiveSelected.map((definition) => `gbrain://source/${definition.sourceKey}`);
  }

  /** Stable content-source identity. Never derive this from the audience. */
  static sourceKeyForKnowledgeBase(kbId: string): string {
    return sourceKeyForKnowledgeBase(kbId);
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
    const groups = new Map<
      string,
      { sourceKey: string; kind: string; scopeKey: string; kbIds: string[] }
    >();
    for (const kb of kbs) {
      // A Source is a durable content/repository boundary, not an ACL cache.
      // Reusing an audience-hash Source made a KB move every time a role or
      // organization changed. That caused stale results and unnecessary
      // reindexing. Permission is represented by BrainSourceMember/OAuth and
      // checked again against the application DB at answer time.
      const sourceKey = sourceKeyForKnowledgeBase(kb.id);
      const scopeKey = `kb:${kb.id}`;
      const group = groups.get(sourceKey) || {
        sourceKey,
        kind: kb.type,
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
    userId?: string,
    changedDocIds: string[] = [],
    options: { forceFull?: boolean } = {},
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
    if (userId) {
      await db.brainSourceMember.upsert({
        where: { sourceId_userId: { sourceId: source.id, userId } },
        create: { sourceId: source.id, userId },
        update: {},
      });
    }
    await this.gbrain.initializeSource(definition.sourceKey);

    const materialized = options.forceFull
      ? false
      : await this.gbrain.isSourceMaterialized(
          `gbrain://source/${definition.sourceKey}`,
        );

    // Incremental fast path: when an already-materialized source receives an
    // explicit batch of changed documents, only those documents are relevant.
    // Skip the full inventory scan and the stale sweep (deletions are handled
    // by onKnowledgeDeleted and periodic reconciliation). This turns an O(N)
    // scan per sync into an O(batch) lookup — the difference between ~0.3
    // docs/s and a scalable bulk import.
    const incremental =
      !options.forceFull && materialized && changedDocIds.length > 0;

    const desired = incremental
      ? await this.prisma.document.findMany({
          where: {
            id: { in: changedDocIds },
            kbId: { in: definition.kbIds },
            status: { in: ["published", "indexing"] },
          },
          select: { id: true, kbId: true, version: true, updatedAt: true },
        })
      : await this.prisma.document.findMany({
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
    // `existing` (all source↔doc mappings) is only needed to detect stale
    // documents and version drift during a full reconcile; the incremental path
    // already knows exactly which docs changed.
    const existing: any[] = incremental
      ? []
      : await db.brainSourceDocument.findMany({
          where: { sourceId: source.id },
          select: { documentId: true, syncedVersion: true, syncedAt: true },
        });
    const existingById = new Map<string, any>(
      existing.map((doc: any) => [doc.documentId, doc] as [string, any]),
    );
    const changedSet = new Set(changedDocIds);
    const toSync = options.forceFull
      ? desired
      : incremental
        ? desired
        : desired.filter((doc) => {
            const previous = existingById.get(doc.id);
            return (
              !materialized ||
              changedSet.has(doc.id) ||
              !previous ||
              doc.version > previous.syncedVersion ||
              doc.updatedAt > previous.syncedAt
            );
          });
    if (options.forceFull || toSync.length) {
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
      const sourceRef = `gbrain://source/${definition.sourceKey}`;
      if (options.forceFull) {
        await this.gbrain.rebuild(sourceRef, evidences);
      } else {
        await this.gbrain.ingest(sourceRef, evidences);
      }
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
    if (this.backupService) {
      const repoPath = typeof (this.gbrain as any).getSourcePath === 'function'
        ? (this.gbrain as any).getSourcePath(definition.sourceKey)
        : null;
      if (repoPath) {
        this.backupService.pushBackup(repoPath, definition.sourceKey).catch((err) => {
          this.logger.warn(`Source backup failed for ${definition.sourceKey}: ${err.message}`);
        });
      }
    }
    return {
      sourceKey: definition.sourceKey,
      synced: toSync.length,
      removed: stale.length,
    };
  }

  /**
   * Source-centric sync used by ingestion. A document is indexed once per
   * stable knowledge-base source, never once for every reader.
   */
  async syncKnowledgeBaseSource(
    kbId: string,
    changedDocIds: string[] = [],
    forceFull = false,
  ) {
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, type: true, status: true },
    });
    if (!kb || kb.status !== "active") {
      throw new Error(`Knowledge base ${kbId} is unavailable for source sync.`);
    }
    return this.syncSourceDefinition(
      {
        sourceKey: sourceKeyForKnowledgeBase(kb.id),
        kind: kb.type,
        scopeKey: `kb:${kb.id}`,
        kbIds: [kb.id],
      },
      undefined,
      changedDocIds,
      { forceFull },
    );
  }

  /**
   * Reconcile every active knowledge-base Source against the published
   * document inventory and rebuild each Source from canonical pages. This is
   * an explicit recovery operation for legacy scope-source drift and is also
   * safe to repeat because it is deterministic and source-scoped.
   */
  async rebuildAllSources(): Promise<{
    sources: number;
    rebuilt: number;
    failed: number;
    syncedDocuments: number;
    removedDocuments: number;
    results: Array<Record<string, unknown>>;
  }> {
    const kbs = await this.prisma.knowledgeBase.findMany({
      where: { status: "active" },
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: "asc" },
    });
    const results: Array<Record<string, unknown>> = [];
    let syncedDocuments = 0;
    let removedDocuments = 0;

    for (const kb of kbs) {
      try {
        const result = await this.syncKnowledgeBaseSource(kb.id, [], true);
        syncedDocuments += Number(result.synced || 0);
        removedDocuments += Number(result.removed || 0);
        const scopeIds = await this.invalidateScopesForSource(result.sourceKey);
        if (scopeIds.length) await this.queueScopeSynthesis(scopeIds);
        results.push({
          kbId: kb.id,
          kbName: kb.name,
          type: kb.type,
          sourceKey: result.sourceKey,
          status: "completed",
          synced: result.synced,
          removed: result.removed,
          affectedScopes: scopeIds.length,
        });
      } catch (error: any) {
        results.push({
          kbId: kb.id,
          kbName: kb.name,
          type: kb.type,
          sourceKey: sourceKeyForKnowledgeBase(kb.id),
          status: "failed",
          error: String(error?.message || error),
        });
      }
    }

    // Re-materialize current memberships after the content plane is repaired.
    // This also archives obsolete empty sources without exposing private data.
    try {
      await this.reconcileAccess();
    } catch (error: any) {
      results.push({
        sourceKey: "access-reconciliation",
        status: "failed",
        error: String(error?.message || error),
      });
    }

    return {
      sources: kbs.length,
      rebuilt: results.filter((item) => item.status === "completed").length,
      failed: results.filter((item) => item.status === "failed").length,
      syncedDocuments,
      removedDocuments,
      results,
    };
  }

  /**
   * Query-time freshness gate. The application DB is authoritative for ACL
   * and published inventory; GBrain status is authoritative for the searchable
   * read plane. If drift is detected, small sources are synced synchronously,
   * while larger sources trigger asynchronous priority rebuild and fail closed
   * to avoid blocking the user query path.
   */
  async ensureSourcesFreshForQuery(
    userId: string,
    knowledgeBaseIds: string[],
  ): Promise<{ checked: number; rebuilt: number; fresh: boolean; staleSources: string[]; sourceKeys: string[] }> {
    const requested = new Set(knowledgeBaseIds);
    const plan = (await this.getSourcePlan(userId)).filter((definition) =>
      definition.kbIds.some((kbId) => requested.has(kbId)),
    );
    if (!plan.length) return { checked: 0, rebuilt: 0, fresh: true, staleSources: [], sourceKeys: [] };

    const sourceIds = plan.map((definition) => definition.sourceKey);
    const indexedPageCounts = await this.gbrain.getSourcePageCounts(sourceIds);
    const db: any = this.prisma as any;
    const staleDefinitions: typeof plan = [];
    const rebuilt: string[] = [];
    const publishedCounts = new Map<string, number>();

    for (const definition of plan) {
      const source = await db.brainSource.findUnique({
        where: { sourceKey: definition.sourceKey },
        select: { id: true },
      });
      // Keep the query path O(1) in application memory. The old code loaded
      // every published document and every source mapping on every chat query;
      // at 100k documents that created a large allocation and network transfer
      // before semantic-cache lookup. Let PostgreSQL perform two index-backed
      // EXISTS checks and return only a count + one boolean instead.
      const inventory = source
        ? await this.prisma.$queryRaw<Array<{ publishedCount: number | bigint; mappingStale: boolean }>>`
            SELECT
              (
                SELECT COUNT(*)
                FROM "Document" d
                WHERE d."kbId" = ANY(${definition.kbIds}::uuid[])
                  AND d.status = 'published'
              ) AS "publishedCount",
              (
                EXISTS (
                  SELECT 1
                  FROM "Document" d
                  LEFT JOIN "BrainSourceDocument" m
                    ON m."documentId" = d.id
                   AND m."sourceId" = ${source.id}::uuid
                  WHERE d."kbId" = ANY(${definition.kbIds}::uuid[])
                    AND d.status = 'published'
                    AND (
                      m."documentId" IS NULL
                      OR m."syncedVersion" < d.version
                      OR m."syncedAt" < d."updatedAt"
                    )
                  LIMIT 1
                )
                OR EXISTS (
                  SELECT 1
                  FROM "BrainSourceDocument" m
                  LEFT JOIN "Document" d ON d.id = m."documentId"
                  WHERE m."sourceId" = ${source.id}::uuid
                    AND (
                      d.id IS NULL
                      OR d.status <> 'published'
                      OR NOT (d."kbId" = ANY(${definition.kbIds}::uuid[]))
                    )
                  LIMIT 1
                )
              ) AS "mappingStale"
          `
        : [{
            publishedCount: await this.prisma.document.count({
              where: { kbId: { in: definition.kbIds }, status: "published" },
            }),
            mappingStale: true,
          }];
      const publishedCount = Number(inventory[0]?.publishedCount || 0);
      publishedCounts.set(definition.sourceKey, publishedCount);
      const mappingFresh = !inventory[0]?.mappingStale;
      const indexedPages = indexedPageCounts.get(definition.sourceKey);
      const readPlaneFresh = indexedPages === publishedCount;
      if (mappingFresh && readPlaneFresh) continue;

      staleDefinitions.push(definition);
    }

    if (staleDefinitions.length) {
      for (const definition of staleDefinitions) {
        const publishedCount = publishedCounts.get(definition.sourceKey) || 0;
        if (publishedCount <= 1) {
          await this.syncSourceDefinition(definition, userId, [], {
            forceFull: true,
          });
          rebuilt.push(definition.sourceKey);
        } else {
          await this.compilerQueue.add(
            "source-sync",
            { kbId: definition.kbIds[0], docIds: [] },
            {
              jobId: `rebuild-source-${definition.sourceKey}`,
              priority: CompilePriority.CRITICAL,
              removeOnComplete: true,
              removeOnFail: 100,
            },
          );
        }
      }
    }

    const unbuiltStale = staleDefinitions
      .filter((def) => !rebuilt.includes(def.sourceKey))
      .map((def) => def.sourceKey);

    if (rebuilt.length || unbuiltStale.length) {
      await this.outboxService.logOperation("sync", {
        phase: "query_freshness_reconcile",
        counts: { checked: plan.length, rebuilt, unbuiltStale, sourceKeys: sourceIds },
        status: unbuiltStale.length ? "warning" : "success",
      });
    }

    return {
      checked: plan.length,
      rebuilt: rebuilt.length,
      fresh: unbuiltStale.length === 0,
      staleSources: unbuiltStale,
      sourceKeys: sourceIds,
    };
  }

  /** Mark every materialized permission scope containing a source as stale. */
  async invalidateScopesForSource(sourceKey: string, type: 'acl' | 'knowledge' = 'knowledge'): Promise<string[]> {
    const db: any = this.prisma as any;
    let scopes: any[] = [];
    try {
      scopes = await db.brainScope.findMany({
        where: { sourceKeys: { array_contains: sourceKey }, status: { not: "archived" } },
        select: { id: true, sourceKeys: true },
      });
    } catch {
      scopes = [];
    }
    if (!scopes.length) {
      const allActive = await db.brainScope.findMany({
        where: { status: { not: "archived" } },
        select: { id: true, sourceKeys: true },
      }).catch(() => []);
      scopes = allActive.filter((s: any) => {
        const keys = Array.isArray(s.sourceKeys) ? s.sourceKeys : [];
        return keys.includes(sourceKey);
      });
    }
    if (!scopes.length) return [];
    const updateData = type === 'acl'
      ? { aclEpoch: { increment: 1 }, status: "dirty" }
      : { knowledgeEpoch: { increment: 1 }, status: "dirty" };
    await db.brainScope.updateMany({
      where: { id: { in: scopes.map((scope: any) => scope.id) } },
      data: updateData,
    });
    return scopes.map((scope: any) => scope.id);
  }

  async invalidateKbScope(kbId: string, type: 'acl' | 'knowledge' = 'acl'): Promise<void> {
    return this.scopeService.invalidateKbScope(kbId, type);
  }

  async invalidateUserScope(userId: string): Promise<void> {
    return this.scopeService.invalidateUserScope(userId);
  }

  async queueScopeSynthesis(scopeIds: string[], priority = CompilePriority.NORMAL): Promise<void> {
    await Promise.all(scopeIds.map((scopeId) =>
      this.compilerQueue.add(
        "scope-derived-compile",
        { scopeId },
        {
          jobId: `scope-compile-${scopeId}`,
          priority,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      ),
    ));
  }

  /** Durable, queue-triggered reconciliation after organization/role/ACL changes. */
  async reconcileAccess(): Promise<{
    users: number;
    sourcesSynced: number;
    scopesReconciled: number;
    sourcesArchived: number;
    scopesArchived: number;
  }> {
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
        const result = await this.syncSourceDefinition(definition, user.id);
        if (result.synced || result.removed) {
          const scopeIds = await this.invalidateScopesForSource(definition.sourceKey);
          await this.queueScopeSynthesis(scopeIds);
        }
        syncedSourceKeys.add(definition.sourceKey);
      }
      // 计算并更新该用户的权限 Scope
      const scopeRes = await this.scopeService.resolveUserScope(user.id);
      reconciledScopeIds.add(scopeRes.scopeId);

      // Scope derivation is scheduled only when its knowledge/ACL epoch is
      // dirty. This avoids rebuilding summaries for every unaffected user.
      if (scopeRes.strategy === "eager" && scopeRes.status === "dirty") {
        await this.queueScopeSynthesis([scopeRes.scopeId]);
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
    const emptyScopes = await db.brainScope.findMany({
      where: { members: { none: {} }, status: { in: ["active", "dirty", "compiling"] } },
      select: { id: true },
    });
    if (emptyScopes.length) {
      await db.brainScope.updateMany({
        where: { id: { in: emptyScopes.map((item: any) => item.id) } },
        data: { status: "archived" },
      });
    }

    return {
      users: users.length,
      sourcesSynced: syncedSourceKeys.size,
      scopesReconciled: reconciledScopeIds.size,
      sourcesArchived: emptySources.length,
      scopesArchived: emptyScopes.length,
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
  }

  /**
   * 触发器：知识发布时，将影响面加入 Dirty 队列
   */
  async onKnowledgePublished(
    kbId: string,
    docId: string,
    topics: string[],
  ): Promise<number> {
    const sourceKey = sourceKeyForKnowledgeBase(kbId);
    const publishedDocument = await this.prisma.document.findUnique({
      where: { id: docId },
      select: { version: true },
    });
    const publishVersion = publishedDocument?.version || Date.now();
    return this.coalesceSourceSync(kbId, sourceKey, docId, topics, publishVersion);
  }

  /**
   * Coalesce per-document publishes into ONE source-sync job per knowledge-base
   * Source. Previously every document enqueued its own job (jobId contained the
   * docId), and the dirty-compiler worker runs serially, so a bulk import ran
   * one full source sync per document: two O(N) inventory scans plus three
   * GBrain CLI invocations each, i.e. O(N^2) overall. Merging dirty docIds into
   * a single delayed job lets `syncKnowledgeBaseSource` ingest the whole batch
   * with one scan and one CLI call, which is what makes 10 万级 imports finish
   * in hours instead of days.
   */
  private async coalesceSourceSync(
    kbId: string,
    sourceKey: string,
    docId: string,
    topics: string[],
    publishVersion: number,
  ): Promise<number> {
    const baseJobId = `source-sync-${sourceKey}`;
    const batchSize = Math.max(1, Number(process.env.SOURCE_SYNC_BATCH_SIZE || 100));
    const debounceMs = Math.max(0, Number(process.env.SOURCE_SYNC_DEBOUNCE_MS || 4000));

    const mergeInto = async (job: Job): Promise<number> => {
      const data = (job.data || {}) as any;
      const docIds = Array.from(new Set<string>([...(data.docIds || []), docId]));
      const mergedTopics = Array.from(new Set<string>([...(data.topics || []), ...topics]));
      await job.updateData({ kbId, docIds, topics: mergedTopics });
      if (docIds.length >= batchSize && typeof (job as any).promote === "function") {
        // Batch is full: flush immediately instead of waiting out the debounce.
        await (job as any).promote().catch(() => undefined);
      }
      return docIds.length;
    };

    const existing = await this.compilerQueue.getJob(baseJobId).catch(() => undefined);
    if (existing) {
      const state = await existing.getState().catch(() => "unknown");
      if (["delayed", "waiting", "prioritized", "paused", "waiting-children"].includes(state)) {
        return mergeInto(existing as Job);
      }
      // A sync is already running for this source. Do not mutate its data;
      // enqueue a unique follow-up so this document is not lost.
      await this.compilerQueue.add(
        "source-sync",
        { kbId, docIds: [docId], topics },
        {
          jobId: `${baseJobId}-${docId}-v${publishVersion}`,
          priority: CompilePriority.NORMAL,
          attempts: 30,
          backoff: { type: "fixed", delay: 20_000 },
          removeOnComplete: true,
          removeOnFail: 500,
        },
      );
      return 1;
    }

    await this.compilerQueue.add(
      "source-sync",
      { kbId, docIds: [docId], topics },
      {
        jobId: baseJobId,
        delay: debounceMs,
        priority: CompilePriority.NORMAL,
        // The core-indexing gate defers publish until every required chunk
        // carries an embedding. Keep retrying across a long window; enrichment
        // completion re-drives the publish (see enrichment.processor).
        attempts: 30,
        backoff: { type: "fixed", delay: 20_000 },
        // Reuse the fixed jobId after completion so the next batch starts fresh.
        removeOnComplete: true,
        removeOnFail: 500,
      },
    );
    // A concurrent publish may have raced the add; merge this docId in to be
    // sure it is never dropped.
    const created = await this.compilerQueue.getJob(baseJobId).catch(() => undefined);
    if (created) {
      const state = await created.getState().catch(() => "unknown");
      if (state === "delayed" || state === "waiting" || state === "prioritized") {
        return mergeInto(created as Job);
      }
    }
    return 1;
  }

  /**
   * Re-queue a subset of documents whose core indexing is not yet complete so a
   * single slow document cannot block a whole coalesced batch.
   */
  async requeueIncompleteSourceSync(kbId: string, docIds: string[], delayMs = 20_000): Promise<void> {
    if (!docIds.length) return;
    const sourceKey = sourceKeyForKnowledgeBase(kbId);
    await this.compilerQueue.add(
      "source-sync",
      { kbId, docIds, topics: [] },
      {
        jobId: `source-sync-${sourceKey}-retry-${Date.now()}`,
        delay: Math.max(0, delayMs),
        priority: CompilePriority.NORMAL,
        attempts: 30,
        backoff: { type: "fixed", delay: 20_000 },
        removeOnComplete: true,
        removeOnFail: 500,
      },
    );
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
      const scopeIds = await this.invalidateScopesForSource(sourceKey);
      await this.queueScopeSynthesis(scopeIds, CompilePriority.HIGH);
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
            if (res.synced || res.removed) {
              await this.invalidateScopesForSource(def.sourceKey);
            }
            const dream = await this.gbrain.maintain(`gbrain://source/${def.sourceKey}`);
            const gbrainStatus = dream?.status || "completed";
            const gbrainFailed = ["failed", "error"].includes(String(gbrainStatus));
            const phaseSummary = Array.isArray(dream?.phases)
              ? dream.phases.map((phase: any) => ({
                  phase: phase.phase,
                  status: phase.status,
                  summary: phase.summary,
                  reason: phase.reason,
                }))
              : [];
            const failedPhases = phaseSummary.filter((phase: any) =>
              ["failed", "error"].includes(String(phase.status)),
            );
            const warningPhases = phaseSummary.filter((phase: any) =>
              ["warn", "warning"].includes(String(phase.status)),
            );

            // A named Source is intentionally excluded from GBrain's implicit
            // global Dream phases. Those expected skips must not make the
            // platform report a false failure; only actual failures/warnings
            // degrade the Source freshness result.
            let graphExtraction: Record<string, unknown> = {
              status: "skipped",
              reason: "disabled",
            };
            if (
              process.env.GBRAIN_GRAPH_EXTRACT_ENABLED !== "0"
            ) {
              try {
                // GBrain's extract command is incremental: unchanged Sources
                // report zero processed pages, while a newly enabled graph
                // still gets its first backfill without a full rebuild.
                const extracted = await this.gbrain.extract(def.sourceKey, { ner: true });
                graphExtraction = {
                  status: "completed",
                  linksCreated: Number(extracted.links_created || 0),
                  timelineEntriesCreated: Number(extracted.timeline_entries_created || 0),
                  pagesProcessed: Number(extracted.pages_processed || 0),
                  skippedCrossSource: Number(extracted.skipped_cross_source || 0),
                };
              } catch (error: any) {
                graphExtraction = {
                  status: "failed",
                  error: String(error?.message || error),
                };
              }
            }
            const sourceStatus = gbrainFailed || failedPhases.length || graphExtraction.status === "failed"
              ? "failed"
              : warningPhases.length
                ? "partial"
                : "completed";
            sourceResults.push({
              sourceKey: def.sourceKey,
              kind: def.kind,
              synced: res.synced,
              removed: res.removed,
              status: sourceStatus,
              gbrainStatus,
              phases: phaseSummary,
              expectedSkippedPhases: phaseSummary
                .filter((phase: any) => phase.status === "skipped")
                .map((phase: any) => phase.phase)
                .filter(Boolean),
              failedPhases: failedPhases.map((phase: any) => phase.phase).filter(Boolean),
              warningPhases: warningPhases.map((phase: any) => phase.phase).filter(Boolean),
              graphExtraction,
            });
            maintainedSources.add(def.sourceKey);
          }
        }
      }

      // === Tier 2: Scope Dream (权限 Scope 跨源综合与派生智能维护) ===
      const dirtyScopes = await db.brainScope.findMany({
        where: {
          status: "dirty",
        },
      });
      for (const scope of dirtyScopes) {
        try {
          const result = await this.scopeService.compileScopeDerived(scope.id);
          scopesCompiled++;
          sourceResults.push({
            sourceKey: `scope:${scope.fingerprint}`,
            kind: "scope-synthesize",
            status: result.status,
            synthesizedSources: result.synthesizedSources,
            synthesisFallbacks: result.synthesisFallbacks,
          });
        } catch (e: any) {
          this.logger.warn(`Failed Scope Dream for ${scope.fingerprint}: ${e.message}`);
          sourceResults.push({
            sourceKey: `scope:${scope.fingerprint}`,
            kind: "scope-synthesize",
            status: "failed",
            error: String(e?.message || e),
          });
        }
      }

      // === Tier 3: Knowledge Health & Lifecycle Maintenance ===
      const now = new Date();
      let expiredDocsCount = 0;
      let conflictFamiliesCount = 0;
      try {
        const expiredUpdate = await this.prisma.document.updateMany({
          where: {
            status: "published",
            effectiveTo: { lte: now },
            lifecycleStatus: { not: "expired" },
          },
          data: { lifecycleStatus: "expired" },
        });
        expiredDocsCount = expiredUpdate.count;

        const conflicting = await (this.prisma.document as any).groupBy({
          by: ['title', 'kbId'],
          where: { status: "published", lifecycleStatus: "current" },
          _count: { id: true },
          having: { id: { _count: { gt: 1 } } },
        }).catch(() => []);
        conflictFamiliesCount = conflicting.length;

        sourceResults.push({
          sourceKey: "system:health",
          kind: "lifecycle-audit",
          status: "completed",
          expiredDocsUpdated: expiredDocsCount,
          conflictingFamiliesDetected: conflictFamiliesCount,
        });
      } catch (healthErr: any) {
        this.logger.warn(`Health maintenance check partial: ${healthErr.message}`);
      }

      this.logger.log(
        `Two-Tier Dream Cycle completed: synced ${syncedDocs} doc(s), compiled ${scopesCompiled} scope(s), audited ${expiredDocsCount} expired doc(s).`,
      );
      const hasFailed = sourceResults.some((result) => result.status === "failed");
      const hasPartial = sourceResults.some((result) => result.status === "partial");
      const status = hasFailed ? "failed" : hasPartial ? "partial" : "completed";
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

  async getDreamTelemetry(options: { excludePrivate?: boolean; runsPage?: number; runsLimit?: number } = {}) {
    const db: any = this.prisma as any;
    const runsPage = Math.max(1, options.runsPage || 1);
    const runsLimit = Math.max(1, Math.min(100, options.runsLimit || 20));
    const privateSourceRows = options.excludePrivate
      ? await db.brainSource.findMany({
          where: { status: "active" },
          select: {
            sourceKey: true,
            documents: { select: { document: { select: { kb: { select: { type: true } } } } } },
          },
        })
      : [];
    const privateSourceKeys = new Set(
      privateSourceRows
        .filter((source: any) => source.documents.some((item: any) => item.document?.kb?.type === "personal"))
        .map((source: any) => source.sourceKey),
    );
    const [lastRun, runs, runsTotal, sources, scopes, derivedCount, outboxPending, opLogs, dirtyTopics, queueCounts, failedJobs] = await Promise.all([
      db.brainMaintenanceRun.findFirst({ orderBy: { startedAt: "desc" } }),
      db.brainMaintenanceRun.findMany({ orderBy: { startedAt: "desc" }, skip: (runsPage - 1) * runsLimit, take: runsLimit }),
      db.brainMaintenanceRun.count(),
      db.brainSource.findMany({
        where: options.excludePrivate
          ? { status: "active", documents: { none: { document: { kb: { type: "personal" } } } } }
          : { status: "active" },
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
      options.excludePrivate
        ? Promise.resolve([])
        : db.brainOperationLog.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      db.brainTopic.count({ where: { compileStatus: "dirty" } }),
      this.compilerQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
      this.compilerQueue.getJobs(["failed"], 0, 49),
    ]);
    const lastStartedAt = lastRun?.startedAt ? new Date(lastRun.startedAt).getTime() : 0;
    const staleAfterMs = Math.max(90 * 60 * 1000, Number(process.env.GBRAIN_MAINTENANCE_STALE_MS || 36 * 60 * 60 * 1000));
    const safeScopes = options.excludePrivate
      ? scopes.filter((scope: any) =>
          !(Array.isArray(scope.sourceKeys) ? scope.sourceKeys : []).some((key: string) => privateSourceKeys.has(key)),
        )
      : scopes;
    const safeScopeIds = safeScopes.map((scope: any) => scope.id);
    const safeDerivedCount = options.excludePrivate
      ? await db.brainDerivedPage.count({ where: { scopeId: { in: safeScopeIds } } })
      : derivedCount;
    const sanitizeRun = (run: any) => {
      if (!options.excludePrivate || !Array.isArray(run?.sourceResults)) return run;
      return {
        ...run,
        sourceResults: run.sourceResults.filter((result: any) => {
          const key = result?.sourceKey || result?.source || result?.sourceName;
          return !key || !privateSourceKeys.has(key);
        }),
      };
    };
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
      lastRun: sanitizeRun(lastRun),
      runs: runs.map(sanitizeRun),
      runsPagination: {
        page: runsPage,
        limit: runsLimit,
        total: runsTotal,
        totalPages: Math.max(1, Math.ceil(runsTotal / runsLimit)),
      },
      sources: sources.map((source: any) => ({
        sourceKey: source.sourceKey,
        kind: source.kind,
        status: source.status,
        scopeKey: source.scopeKey,
        lastSyncAt: source.lastSyncAt,
        members: source._count.members,
        documents: source._count.documents,
      })),
      scopes: safeScopes.map((s: any) => ({
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
      derivedPagesCount: safeDerivedCount,
      outboxPendingEvents: outboxPending,
      recentOperationLogs: opLogs,
      dirtyTopics,
      queueCounts,
      maintenanceFailures: (failedJobs || [])
        .filter((job: any) => Boolean(job && job.name === "gbrain-maintenance"))
        .map((job: any) => ({
          id: job.id,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
        })),
    };
  }
}
