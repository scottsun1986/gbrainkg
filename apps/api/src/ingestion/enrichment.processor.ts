import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Optional } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ChunkEmbeddingService } from '../embedding/chunk-embedding.service';
import { RaptorService } from '../raptor/raptor.service';
import { GraphRagService } from '../graph-rag/graph-rag.service';
import { ModelConfigService } from '../model-config.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';

export interface EnrichmentJobData {
  documentId: string;
  kbId: string;
  // Version of the document whose chunks this job was queued for. When the
  // document has since been re-ingested the job must not touch readiness.
  expectedVersion?: number;
}

/**
 * Post-publish enrichment pipeline, executed through a durable queue with
 * retries instead of fire-and-forget promises:
 *   chunk embeddings → RAPTOR summary tree (opt-in) → GraphRAG extraction (opt-in)
 * The document carries an indexReadiness state machine
 * (pending → enriching → ready | degraded) so callers and the UI can tell
 * whether a document is fully indexed.
 */
@Processor('enrichment-queue', { concurrency: Number(process.env.ENRICHMENT_CONCURRENCY || 2) })
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly chunkEmbeddingService: ChunkEmbeddingService,
    private readonly raptorService: RaptorService,
    private readonly graphRagService: GraphRagService,
    private readonly modelConfigService: ModelConfigService,
    @Optional() private readonly compilerService?: BrainCompilerService,
  ) {
    super();
  }

  async process(job: Job<EnrichmentJobData>): Promise<{ readiness: string }> {
    const { documentId, kbId, expectedVersion } = job.data;
    if (expectedVersion !== undefined) {
      const current = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { version: true },
      });
      if (!current || current.version !== expectedVersion) {
        this.logger.warn(
          `Enrichment for ${documentId} skipped: version ${expectedVersion} superseded by ${current?.version ?? 'deleted'}.`,
        );
        return { readiness: 'superseded' };
      }
    }
    await this.setReadiness(documentId, 'enriching');
    try {
      if (this.chunkEmbeddingService.isEnabled()) {
        await this.chunkEmbeddingService.embedDocumentChunks(documentId);
        // Verify coverage instead of trusting the embed pass: null vectors are
        // swallowed by the fail-open embedding client.
        const coverage = await this.chunkEmbeddingService.documentCoverage(documentId);
        if (coverage.missing > 0) {
          throw new Error(
            `Chunk embedding incomplete for ${documentId}: ${coverage.missing}/${coverage.total} chunks missing vectors.`,
          );
        }
      }
      if (this.raptorService.isEnabled()) {
        await this.raptorService.indexDocument(kbId, documentId);
      }
      if (process.env.AUTO_GRAPH_EXTRACT_ENABLED === 'true') {
        await this.extractGraph(kbId, documentId);
      }
      await this.setReadiness(documentId, 'ready');
      // Self-healing publish re-drive: the source-sync job gates publishing on
      // complete embeddings and its retry window may have expired while this
      // enrichment was still running, leaving the document stranded in
      // 'indexing'. Re-drive the publish now that readiness is 'ready'.
      try {
        const doc = await this.prisma.document.findUnique({
          where: { id: documentId },
          select: { kbId: true, status: true },
        });
        if (doc && doc.status === 'indexing' && this.compilerService?.onKnowledgePublished) {
          await this.compilerService.onKnowledgePublished(doc.kbId, documentId, []);
          this.logger.log(`Re-drove source publish for fully enriched document ${documentId}.`);
        }
      } catch (err) {
        this.logger.warn(
          `Publish re-drive failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { readiness: 'ready' };
    } catch (err) {
      await this.setReadiness(documentId, 'degraded').catch(() => undefined);
      this.logger.error(
        `Enrichment failed for ${documentId} (attempt ${job.attemptsMade + 1}): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err; // let BullMQ retry with backoff
    }
  }

  private async setReadiness(documentId: string, readiness: string): Promise<void> {
    await this.prisma.document.update({
      where: { id: documentId },
      data: { indexReadiness: readiness },
    });
  }

  private async extractGraph(kbId: string, documentId: string): Promise<void> {
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
          modelName: cfg.modelName || process.env.LLM_MODEL ,
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
      await this.graphRagService.buildCommunitiesForKb(kbId).catch(() => undefined);
    }
    this.logger.log(
      `Graph extraction for ${documentId}: ${result.entityCount} entities, ${result.relationCount} relations.`,
    );
  }
}
