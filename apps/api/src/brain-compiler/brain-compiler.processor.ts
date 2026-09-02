import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { BrainRepoAdapter } from "@llmwiki/gbrain-adapter";
import { PrismaClient } from "@prisma/client";
import { PermissionService } from "../permission/permission.service";
import { ModelConfigService } from "../model-config.service";
import { BrainCompilerService } from "./brain-compiler.service";
import { BrainScopeService } from "./brain-scope.service";
import { BrainOutboxService } from "./brain-outbox.service";
import { readCanonicalDocument } from "./canonical-document";

@Processor("dirty-compiler-queue")
export class BrainCompilerProcessor extends WorkerHost {
  private readonly logger = new Logger(BrainCompilerProcessor.name);
  private prisma = new PrismaClient();
  private gbrain = new BrainRepoAdapter(
    process.env.BRAIN_REPO_BASE_PATH || "/tmp/llmwiki/brain_repos",
  );
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || "/tmp/llmwiki/uploads";

  constructor(
    private readonly permissionService: PermissionService,
    private readonly modelConfigService: ModelConfigService,
    private readonly compilerService: BrainCompilerService,
    private readonly scopeService: BrainScopeService,
    private readonly outboxService: BrainOutboxService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const db: any = this.prisma;

    // 1. 权限与组织对账任务
    if (job.name === "access-reconcile") {
      const start = Date.now();
      const res = await this.compilerService.reconcileAccess();
      await this.outboxService.logOperation("sync", {
        phase: "access_reconcile",
        counts: res,
        durationMs: Date.now() - start,
        status: "success",
      });
      return { status: "success", ...res };
    }

    // 2. 双级 Dream Cycle 调度维护（Source Dream + Scope Dream）
    if (job.name === "gbrain-maintenance") {
      const start = Date.now();
      const res = await this.compilerService.runDreamCycle(
        undefined,
        job.data?.source || "scheduled",
      );
      await this.outboxService.logOperation("dream", {
        phase: "two_tier_dream",
        counts: res,
        durationMs: Date.now() - start,
        status: res.status === "completed" ? "success" : res.status === "failed" ? "failed" : "warning",
      });
      return { status: "success", ...res };
    }

    // 3. Source-centric document indexing. A document belongs to one stable
    // knowledge-base Source, therefore a publish event produces one sync even
    // when thousands of users can read it.
    if (job.name === "source-sync") {
      const { kbId, docIds = [] } = job.data;
      const start = Date.now();
      const result = await this.compilerService.syncKnowledgeBaseSource(kbId, docIds);
      if (docIds.length) {
        await this.prisma.document.updateMany({
          where: { id: { in: docIds }, status: "indexing" },
          data: { status: "published" },
        });
      }
      const scopeIds = await this.compilerService.invalidateScopesForSource(result.sourceKey);
      await this.compilerService.queueScopeSynthesis(scopeIds, 3);
      await this.outboxService.logOperation("sync", {
        phase: "source_centric_publish",
        counts: { ...result, documentIds: docIds, affectedScopes: scopeIds.length },
        durationMs: Date.now() - start,
        status: "success",
      });
      return { status: "success", ...result, affectedScopes: scopeIds.length };
    }

    // 4. 消费 Outbox 变更事件
    if (job.name === "process-outbox-event") {
      const { eventId } = job.data;
      const event = await db.brainChangeEvent.findUnique({
        where: { id: eventId },
      });
      if (!event) return { status: "skipped", reason: "Event not found" };

      await db.brainChangeEvent.update({
        where: { id: eventId },
        data: { status: "processing" },
      });

      try {
        const start = Date.now();
        this.logger.log(
          `Processing BrainChangeEvent [${event.id}]: ${event.eventType} on ${event.resourceType} ${event.resourceId}`,
        );

        // 如果是权限变更或用户/组织变更，触发权限与 Scope 对账
        if (
          event.eventType === "perm_grant" ||
          event.eventType === "perm_revoke" ||
          event.eventType === "org_change" ||
          event.eventType === "role_change"
        ) {
          if (event.resourceType === "user" && event.resourceId) {
            await this.scopeService.invalidateUserScope(event.resourceId);
          }
          await this.compilerService.reconcileAccess();
        }

        // 如果是文档变更，触发增量同步
        if (event.eventType === "doc_change" && event.resourceId) {
          const doc = await this.prisma.document.findUnique({
            where: { id: event.resourceId },
            select: { id: true, kbId: true },
          });
          if (doc) {
            await this.compilerService.onKnowledgePublished(
              doc.kbId,
              doc.id,
              ["document"],
            );
          }
        }

        if (event.eventType === "doc_delete" && event.resourceId) {
          const kbId = event.payload?.kbId;
          if (kbId) {
            await this.compilerService.onKnowledgeDeleted(
              kbId,
              event.resourceId,
            );
          }
        }

        await db.brainChangeEvent.update({
          where: { id: eventId },
          data: { status: "completed", processedAt: new Date() },
        });

        await this.outboxService.logOperation("sync", {
          phase: "outbox_event",
          counts: { eventType: event.eventType, resourceType: event.resourceType },
          durationMs: Date.now() - start,
          status: "success",
        });

        return { status: "success", eventId };
      } catch (err: any) {
        this.logger.error(`Failed to process Outbox Event [${eventId}]: ${err.message}`);
        await db.brainChangeEvent.update({
          where: { id: eventId },
          data: {
            status: "failed",
            errorMessage: err.message,
            retryCount: { increment: 1 },
          },
        });
        throw err;
      }
    }

    // 5. Scope 派生智能产物编译任务
    if (job.name === "scope-derived-compile") {
      const { scopeId } = job.data;
      const start = Date.now();
      const res = await this.scopeService.compileScopeDerived(scopeId);
      await this.outboxService.logOperation("scope_compile", {
        scopeId,
        phase: "derived_summary",
        counts: res,
        durationMs: Date.now() - start,
        status: "success",
      });
      return { status: "success", ...res };
    }

    // 6. 传统单主题/文档编译 Job（兼容旧队列任务）
    const { userId, topicSlug, source, docIds = [], sourceKey } = job.data;
    this.logger.debug(
      `Starting compile job for User: ${userId}, Topic: ${topicSlug}`,
    );

    const compileStartedAt = Date.now();
    let brainTopicId: string | undefined;

    try {
      await this.modelConfigService.applyRuntimeConfig();
      const brainRepo = await this.prisma.brainRepo.findUnique({
        where: { userId },
      });
      if (!brainRepo) throw new Error(`BrainRepo not found for user ${userId}`);

      const visibleKbIds =
        await this.permissionService.getVisibleKnowledgeBases(userId);
      const documents =
        this.prisma.document?.findMany && visibleKbIds.length > 0
          ? await this.prisma.document.findMany({
              where: {
                kbId: { in: visibleKbIds },
                status: "published",
                ...(docIds.length > 0
                  ? { id: { in: docIds } }
                  : {
                      OR: [
                        { title: { contains: topicSlug, mode: "insensitive" } },
                        {
                          chunks: {
                            some: {
                              content: {
                                contains: topicSlug,
                                mode: "insensitive",
                              },
                            },
                          },
                        },
                      ],
                    }),
              },
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
              take: 20,
            })
          : [];
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

      if (sourceKey) {
        await this.compilerService.syncSourceIncremental(
          sourceKey,
          userId,
          docIds,
        );
      } else {
        await this.gbrain.ingest(
          sourceKey ? `gbrain://source/${sourceKey}` : brainRepo.gitRepoUrl,
          evidences,
        );
      }

      if (docIds.length && this.prisma.document?.updateMany) {
        await this.prisma.document.updateMany({
          where: { id: { in: docIds }, status: "indexing" },
          data: { status: "published" },
        });
      }

      if (this.prisma.brainTopic.upsert) {
        const topicRecord = await this.prisma.brainTopic.upsert({
          where: {
            brainRepoId_topicSlug: { brainRepoId: brainRepo.id, topicSlug },
          },
          create: {
            brainRepoId: brainRepo.id,
            topicSlug,
            mdPath: `${topicSlug}.md`,
            lastCompiledAt: new Date(),
          },
          update: {
            compileStatus: "clean",
            lastCompiledAt: new Date(),
            dirtySource: source,
          },
        });
        brainTopicId = topicRecord?.id;
      } else {
        await this.prisma.brainTopic.update({
          where: {
            brainRepoId_topicSlug: { brainRepoId: brainRepo.id, topicSlug },
          },
          data: { compileStatus: "clean", lastCompiledAt: new Date() },
        });
      }
      await this.prisma.brainRepo.update?.({
        where: { id: brainRepo.id },
        data: { lastCompileAt: new Date() },
      });

      const compileJobModel: any = (this.prisma as any).compileJob;
      if (brainTopicId && compileJobModel?.create) {
        await compileJobModel.create({
          data: {
            brainTopicId,
            userId,
            trigger: source || "knowledge_publish",
            status: "completed",
            attempt: Number(job.attemptsMade || 0) + 1,
            inputEvidenceIds: docIds,
            durationMs: Date.now() - compileStartedAt,
            completedAt: new Date(),
          },
        });
      }

      return { status: "success", topicSlug };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const isFinalAttempt =
        Number(job.attemptsMade || 0) + 1 >= Number(job.opts?.attempts || 1);
      if (isFinalAttempt && docIds.length && this.prisma.document?.updateMany) {
        await this.prisma.document
          .updateMany({
            where: { id: { in: docIds }, status: "indexing" },
            data: { status: "failed" },
          })
          .catch(() => undefined);
      }
      const compileJobModel: any = (this.prisma as any).compileJob;
      if (isFinalAttempt && brainTopicId && compileJobModel?.create) {
        await compileJobModel
          .create({
            data: {
              brainTopicId,
              userId,
              trigger: source || "knowledge_publish",
              status: "failed",
              attempt: Number(job.attemptsMade || 0) + 1,
              inputEvidenceIds: docIds,
              truthDiff: message.slice(0, 2000),
              durationMs: Date.now() - compileStartedAt,
              completedAt: new Date(),
            },
          })
          .catch(() => undefined);
      }
      this.logger.error(`Compile job failed: ${message}`, stack);
      throw error;
    }
  }
}
