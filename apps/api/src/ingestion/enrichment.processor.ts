import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ChunkEmbeddingService } from '../embedding/chunk-embedding.service';
import { RaptorService } from '../raptor/raptor.service';
import { GraphRagService } from '../graph-rag/graph-rag.service';
import { ModelConfigService } from '../model-config.service';

export interface EnrichmentJobData {
  documentId: string;
  kbId: string;
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
  ) {
    super();
  }

  async process(job: Job<EnrichmentJobData>): Promise<{ readiness: string }> {
    const { documentId, kbId } = job.data;
    await this.setReadiness(documentId, 'enriching');
    try {
      if (this.chunkEmbeddingService.isEnabled()) {
        await this.chunkEmbeddingService.embedDocumentChunks(documentId);
      }
      if (this.raptorService.isEnabled()) {
        await this.raptorService.indexDocument(kbId, documentId);
      }
      if (process.env.AUTO_GRAPH_EXTRACT_ENABLED === 'true') {
        await this.extractGraph(kbId, documentId);
      }
      await this.setReadiness(documentId, 'ready');
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
