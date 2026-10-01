import { VerifiedLateChunking } from '../embedding/verified-late-chunking';
import { runAsService } from '../db/service-principal';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { setIngestionQueueDepth } from '../observability/failopen';
import { getPrismaClient } from '../prisma';
import { ChunkEmbeddingService } from '../embedding/chunk-embedding.service';
import { RaptorService } from '../raptor/raptor.service';
import { GraphRagService } from '../graph-rag/graph-rag.service';
import { ModelConfigService } from '../model-config.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { LexicalIndexService } from '../retrieval/lexical-index.service';
import { DocumentVersionStore } from './document-version-store';

export interface EnrichmentJobData {
  documentId: string;
  kbId: string;
  outboxEventId?: string;
  // Version of the document whose chunks this job was queued for. When the
  // document has since been re-ingested the job must not touch readiness.
  expectedVersion?: number;
  versionId?: string;
  generationAction?: "build" | "activate";
  generationId?: string;
}

/**
 * Post-publish enrichment pipeline, executed through a durable queue with
 * retries instead of fire-and-forget promises:
 *   chunk embeddings → RAPTOR summary tree (opt-in) → GraphRAG extraction (opt-in)
 * The document carries an indexReadiness state machine
 * (pending → enriching → ready | degraded) so callers and the UI can tell
 * whether a document is fully indexed.
 */
@Processor('enrichment-queue', { concurrency: Number(process.env.ENRICHMENT_CONCURRENCY || 4) })
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly chunkEmbeddingService: ChunkEmbeddingService,
    private readonly raptorService: RaptorService,
    private readonly graphRagService: GraphRagService,
    private readonly modelConfigService: ModelConfigService,
    @Optional() private readonly lexicalIndexService?: LexicalIndexService,
    @Optional() private readonly compilerService?: BrainCompilerService,
    @Optional() @InjectQueue('enrichment-queue') private readonly queue?: Queue,
  ) {
    super();
  }

  /** Report waiting+active as ingestion_queue_depth (metrics must never break the job). */
  private async reportQueueDepth(): Promise<void> {
    try {
      if (!this.queue || typeof this.queue.getJobCounts !== 'function') return;
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
      setIngestionQueueDepth(
        Number(counts.waiting || 0) + Number(counts.active || 0) + Number(counts.delayed || 0),
      );
    } catch {
      /* ignore */
    }
  }

  async process(job: Job<EnrichmentJobData>): Promise<{ readiness: string }> {
    return runAsService("ingestion", () => this.processInternal(job), job.data.kbId);
  }

  private async processInternal(job: Job<EnrichmentJobData>): Promise<{ readiness: string }> {
    await this.reportQueueDepth();
    const { documentId, kbId, expectedVersion, outboxEventId } = job.data;
    const finishOutbox = async (status: 'completed' | 'failed', error?: unknown) => {
      const eventStore = (this.prisma as any).brainChangeEvent;
      if (!outboxEventId || typeof eventStore?.update !== 'function') return;
      await eventStore.update({
        where: { id: outboxEventId },
        data: status === 'completed'
          ? { status, processedAt: new Date(), errorMessage: null }
          : { status, errorMessage: error instanceof Error ? error.message : String(error), retryCount: { increment: 1 } },
      });
    };
    if (outboxEventId && typeof (this.prisma as any).brainChangeEvent?.update === 'function') {
      await (this.prisma as any).brainChangeEvent.update({
        where: { id: outboxEventId }, data: { status: 'processing' },
      });
    }
    if (job.data.versionId) {
      try {
        const version = await this.prisma.documentVersion.findUnique({ where: { id: job.data.versionId }, include: { document: true } });
        if (!version || version.documentId !== documentId || version.document.kbId !== kbId || version.number !== expectedVersion) throw new Error('Invalid version job identity');
        if (job.data.generationAction) {
          const store = new DocumentVersionStore(this.prisma);
          if (version.document.activeVersionId !== version.id) { await finishOutbox('completed'); return { readiness: 'superseded' }; }
          if (job.data.generationAction === 'build') {
            const result = await this.chunkEmbeddingService.embedVersionArtifacts(version.id);
            if (result.missing) throw new Error('Generation embedding coverage incomplete');
            await store.buildDenseGeneration(version.id, result.fingerprint);
          } else {
            if (!job.data.generationId) throw new Error('Generation identity required');
            await store.activateDenseGeneration(version.id, job.data.generationId);
          }
          await finishOutbox('completed'); return { readiness: 'ready' };
        }
        if (version.state === 'published') { await finishOutbox('completed'); return { readiness: 'ready' }; }
        if (version.document.buildingVersionId !== version.id) {
          await finishOutbox('completed'); return { readiness: 'superseded' };
        }
        const result = await this.chunkEmbeddingService.embedVersionArtifacts(version.id);
        if (result.missing) throw new Error(`Version embeddings incomplete: ${result.missing}`);
        const published = await new DocumentVersionStore(this.prisma).publish(version.id, result.fingerprint);
        await finishOutbox('completed');
        return { readiness: published ? 'ready' : 'superseded' };
      } catch (error) { await finishOutbox('failed', error); throw error; }
      finally { await this.reportQueueDepth(); }
    }
    if (expectedVersion !== undefined) {
      const current = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { version: true, kb: { select: { status: true } } },
      });
      if (!current || current.version !== expectedVersion || current.kb?.status === 'archived') {
        this.logger.warn(
          `Enrichment for ${documentId} skipped: version ${expectedVersion} superseded by ${current?.version ?? 'deleted'}.`,
        );
        await finishOutbox('completed');
        return { readiness: 'superseded' };
      }
    }
    if (!(await this.setReadiness(documentId, 'enriching', expectedVersion))) {
      await finishOutbox('completed');
      return { readiness: 'superseded' };
    }
    try {
      const stageStore = (this.prisma as any).enrichmentStage;
      const completed = new Set<string>();
      if (stageStore && expectedVersion !== undefined) {
        const rows = await stageStore.findMany({
          where: { documentId, version: expectedVersion }, select: { stage: true },
        });
        for (const row of rows) completed.add(row.stage);
      }
      const runStage = (stage: string, work: () => Promise<unknown>): Promise<unknown> => {
        if (completed.has(stage)) return Promise.resolve();
        return (async () => {
          const result = await work();
          if (stageStore && expectedVersion !== undefined) {
            await stageStore.upsert({
              where: { documentId_version_stage: { documentId, version: expectedVersion, stage } },
              create: { documentId, version: expectedVersion, stage },
              update: {},
            });
          }
          return result;
        })();
      };
      // Only retrieval-critical dense and lexical indexes occupy these slots.
      // Slow LLM-driven summaries/graph extraction use an independent queue.
      const enrichmentTasks: Promise<any>[] = [];
      if (this.chunkEmbeddingService.isEnabled()) {
        enrichmentTasks.push(
          runStage('embedding', async () => {
            const embeddingResult = await this.chunkEmbeddingService.embedDocumentChunks(documentId);
            // Verify coverage instead of trusting the embed pass: null vectors are
            // swallowed by the fail-open embedding client.
            const coverage = await this.chunkEmbeddingService.documentCoverage(documentId);
            if (coverage.missing > 0) {
              throw new Error(
                `Chunk embedding incomplete for ${documentId}: ${coverage.missing}/${coverage.total} chunks missing vectors.`,
              );
            }
            if (embeddingResult.hybridMissing) {
              throw new Error(`BGE-M3 hybrid index incomplete for ${documentId}: ${embeddingResult.hybridMissing} chunks missing sparse or multi-vector data.`);
            }
          }),
        );
      }
      // Full-corpus BM25 postings. Kept in the enrichment state machine (rather
      // than fire-and-forget) so a failure marks the document degraded and is
      // retried, and so the lexical arm of retrieval is complete exactly when
      // indexReadiness turns ready.
      if (this.lexicalIndexService?.isEnabled?.()) {
        enrichmentTasks.push(
          runStage('lexical', async () => {
            const result = await this.lexicalIndexService!.indexDocument(kbId, documentId);
            if (result.indexed === 0) {
              const stored = await this.prisma.chunk.count({ where: { documentId } });
              if (stored > 0) {
                throw new Error(`Lexical index incomplete for ${documentId}: 0/${stored} chunks indexed.`);
              }
            }
          }),
        );
      }
      const settled = await Promise.allSettled(enrichmentTasks);
      const firstError = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (firstError) {
        // Log all failures for diagnostics before re-throwing
        for (const result of settled) {
          if (result.status === 'rejected') {
            this.logger.error(
              `Enrichment sub-task failed for ${documentId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            );
          }
        }
        throw firstError.reason;
      }
      if (expectedVersion !== undefined) {
        const postCheck = await this.prisma.document.findUnique({
          where: { id: documentId },
          select: { version: true, kb: { select: { status: true } } },
        });
        if (!postCheck || postCheck.version !== expectedVersion || postCheck.kb?.status === 'archived') {
          this.logger.warn(
            `Enrichment for ${documentId} completed but version ${expectedVersion} was superseded by ${postCheck?.version ?? 'deleted'}. Skipping ready broadcast.`,
          );
          await finishOutbox('completed');
          return { readiness: 'superseded' };
        }
      }
      if (!(await this.setReadiness(documentId, 'ready', expectedVersion))) {
        await finishOutbox('completed');
        return { readiness: 'superseded' };
      }
      if (expectedVersion !== undefined && (this.raptorService.isEnabled() || process.env.AUTO_GRAPH_EXTRACT_ENABLED === 'true')) {
        const hash = createHash('sha256').update(`aux:${documentId}:${expectedVersion}`).digest('hex');
        const eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        try {
          await (this.prisma as any).brainChangeEvent.upsert({
            where: { id: eventId },
            create: { id: eventId, eventType: 'aux_enrichment_request', resourceType: 'document',
              resourceId: documentId, payload: { kbId, version: expectedVersion }, status: 'pending' },
            update: {},
          });
        } catch (error) {
          // Optional summary/graph work is not part of core search readiness.
          this.logger.warn(`Could not persist auxiliary enrichment request for ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Self-healing publish re-drive: the source-sync job gates publishing on
      // complete embeddings and its retry window may have expired while this
      // enrichment was still running, leaving the document stranded in
      // 'indexing'. Re-drive the publish now that readiness is 'ready'.
      try {
        const doc = await this.prisma.document.findUnique({
          where: { id: documentId },
          select: { kbId: true, status: true, version: true },
        });
        if (
          doc &&
          doc.status === 'indexing' &&
          (expectedVersion === undefined || doc.version === expectedVersion) &&
          this.compilerService?.onKnowledgePublished
        ) {
          await this.compilerService.onKnowledgePublished(doc.kbId, documentId, []);
          this.logger.log(`Re-drove source publish for fully enriched document ${documentId}.`);
        }
      } catch (err) {
        this.logger.warn(
          `Publish re-drive failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await finishOutbox('completed');
      await this.reportQueueDepth();
      return { readiness: 'ready' };
    } catch (err) {
      await this.setReadiness(documentId, 'degraded', expectedVersion).catch(() => undefined);
      await finishOutbox('failed', err).catch((outboxErr) => {
        this.logger.warn(`Failed to record enrichment outbox status for ${documentId}: ${outboxErr instanceof Error ? outboxErr.message : String(outboxErr)}`);
      });
      this.logger.error(
        `Enrichment failed for ${documentId} (attempt ${job.attemptsMade + 1}): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err; // let BullMQ retry with backoff
    } finally {
      await this.reportQueueDepth();
    }
  }

  /** LLM-dependent indexes run on a separate, bounded worker pool. */
  async processAuxiliary(job: Job<EnrichmentJobData>): Promise<void> {
    const { documentId, kbId, expectedVersion, outboxEventId } = job.data;
    const eventStore = (this.prisma as any).brainChangeEvent;
    if (outboxEventId) await eventStore.update({ where: { id: outboxEventId }, data: { status: 'processing' } });
    try {
      const doc = await this.prisma.document.findUnique({
        where: { id: documentId }, select: { version: true, kb: { select: { status: true } } },
      });
      if (doc && doc.kb?.status === 'active' && (expectedVersion === undefined || doc.version === expectedVersion)) {
        const stageStore = (this.prisma as any).enrichmentStage;
        const rows = expectedVersion === undefined ? [] : await stageStore.findMany({
          where: { documentId, version: expectedVersion }, select: { stage: true },
        });
        const completed = new Set(rows.map((row: { stage: string }) => row.stage));
        const stages: Array<[string, () => Promise<unknown>]> = [];
        if (job.data.versionId && process.env.BGE_M3_LATE_CHUNKING_ENABLED === 'true') stages.push(['late_context', () => new VerifiedLateChunking().buildVersion(job.data.versionId!)]);
        if (this.raptorService.isEnabled()) stages.push(['raptor', () => this.raptorService.indexDocument(kbId, documentId)]);
        if (process.env.AUTO_GRAPH_EXTRACT_ENABLED === 'true') stages.push(['graph', () => this.extractGraph(kbId,documentId)]);
        for (const [stage, work] of stages) {
          if (completed.has(stage)) continue;
          await work();
          if (expectedVersion !== undefined) await stageStore.upsert({
            where: { documentId_version_stage: { documentId, version: expectedVersion, stage } },
            create: { documentId, version: expectedVersion, stage }, update: {},
          });
        }
      }
      if (outboxEventId) await eventStore.update({ where: { id: outboxEventId },
        data: { status: 'completed', processedAt: new Date(), errorMessage: null } });
    } catch (error) {
      if (outboxEventId) await eventStore.update({ where: { id: outboxEventId },
        data: { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error), retryCount: { increment: 1 } } }).catch(() => undefined);
      throw error;
    }
  }

  private async setReadiness(documentId: string, readiness: string, expectedVersion?: number): Promise<boolean> {
    if (expectedVersion !== undefined && typeof (this.prisma as any)?.document?.updateMany === 'function') {
      const updated = await (this.prisma as any).document.updateMany({
        where: { id: documentId, version: expectedVersion },
        data: { indexReadiness: readiness },
      });
      return updated.count === 1;
    } else {
      await this.prisma.document.update({
        where: { id: documentId },
        data: { indexReadiness: readiness },
      });
      return true;
    }
  }

  private async extractGraph(kbId: string, documentId: string): Promise<void> {
    if (process.env.CORE_VERSIONING_ENABLED === '1' && process.env.CORE_GRAPH_INCREMENTAL_ENABLED === '1') {
      await this.graphRagService.scheduleCommunityRebuild(kbId);
      return;
    }
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        title: true,
        version: true,
        chunks: {
          orderBy: { ord: 'asc' },
          take: Number(process.env.AUTO_GRAPH_EXTRACT_MAX_CHUNKS || 50),
          select: { id: true, content: true, metadata: true },
        },
      },
    });
    if (!document || !document.chunks.length) return;
    let llmConfig: { baseUrl: string; apiKey: string; modelName: string } | null = null;
    try {
      const cfg = await this.modelConfigService.getDefault('llm');
      if (cfg) {
        llmConfig = {
          baseUrl: (cfg.provider.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
          apiKey: cfg.provider.apiKey || process.env.DEEPSEEK_API_KEY || '',
          modelName: cfg.modelName || process.env.LLM_MODEL || "",
        };
      }
    } catch {
      llmConfig = null;
    }
    const elements = await this.graphRagService.extractGraphElementsHybrid(
      document.title,
      document.id,
      document.chunks,
      document.version,
      llmConfig,
    );
    const result = await this.graphRagService.persistGraphElements(kbId, elements);
    if (result.entityCount > 0) {
      // Coalesced per-KB rebuild: a bulk import would otherwise trigger an
      // O(KB) full-graph scan for every document. The delay + jobId dedup
      // collapses the whole import into one rebuild.
      await this.graphRagService.scheduleCommunityRebuild(kbId).catch(() => undefined);
    }
    this.logger.log(
      `Graph extraction for ${documentId}: ${result.entityCount} entities, ${result.relationCount} relations.`,
    );
  }
}
