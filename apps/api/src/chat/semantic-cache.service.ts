import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ModelConfigService } from '../model-config.service';
import { EmbeddingService } from '../embedding/embedding.service';

@Injectable()
export class SemanticCacheService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(SemanticCacheService.name);
  private readonly prisma = getPrismaClient();
  private readonly enabled = process.env.SEMANTIC_CACHE_ENABLED !== 'false';
  private readonly similarityThreshold = Number(process.env.SEMANTIC_CACHE_SIMILARITY || '0.96');
  private readonly ttlHours = Number(process.env.SEMANTIC_CACHE_TTL_HOURS || '24');
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly modelConfigService: ModelConfigService,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {}

  onModuleInit(): void {
    // Expired rows are never matched at lookup time (epoch + TTL check), but
    // without periodic cleanup they accumulate forever. Sweep hourly.
    const intervalMs = Number(process.env.SEMANTIC_CACHE_CLEANUP_INTERVAL_MS || 3_600_000);
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(() => undefined);
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    // Route through the shared EmbeddingService first: its in-memory cache
    // makes the cache-lookup embedding and the retrieval-arms embedding of
    // the same query a single upstream call instead of two.
    if (this.embeddingService?.isEnabled()) {
      try {
        const shared = await this.embeddingService.embedOne(text);
        if (shared && shared.length > 0) return shared;
      } catch {
        // fall through to the direct provider call below
      }
    }
    try {
      const config = await this.modelConfigService.getDefault('embedding');
      if (!config) return null;
      const baseUrl = (config.provider.baseUrl || '').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.provider.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelName,
          input: text,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      const data: any = await response.json();
      return data?.data?.[0]?.embedding || null;
    } catch (err) {
      this.logger.error(`Error generating embedding: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async lookup(
    queryText: string,
    scopeFingerprint: string,
    knowledgeEpoch: number,
  ): Promise<any | null> {
    if (!this.enabled) return null;

    try {
      const embedding = await this.getEmbedding(queryText);
      if (!embedding) return null;

      const results = await this.prisma.$queryRaw<any[]>`
        SELECT id, "queryText", "responseContent", citations, "processingTrace", "modelName",
               1 - ("queryEmbedding" <=> ${embedding}::vector) as similarity
        FROM "SemanticCache"
        WHERE "scopeFingerprint" = ${scopeFingerprint}
          AND "knowledgeEpoch" = ${knowledgeEpoch}
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          AND 1 - ("queryEmbedding" <=> ${embedding}::vector) > ${this.similarityThreshold}
        ORDER BY similarity DESC, "createdAt" DESC
        LIMIT 1
      `;

      if (results && results.length > 0) {
        const hit = results[0];
        
        // Async increment hitCount and update lastHitAt
        this.prisma.$executeRaw`
          UPDATE "SemanticCache"
          SET "hitCount" = "hitCount" + 1, "lastHitAt" = NOW()
          WHERE id = ${hit.id}
        `.catch(err => this.logger.error(`Failed to update hit count for ${hit.id}:`, err));

        this.logger.log(`Semantic cache HIT (similarity: ${hit.similarity}) for query: ${queryText.substring(0, 50)}...`);
        return hit;
      }

      this.logger.debug(`Semantic cache MISS for query: ${queryText.substring(0, 50)}...`);
      return null;
    } catch (err) {
      this.logger.error(`Lookup error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async store(
    queryText: string,
    queryEmbedding: number[] | null | undefined,
    scopeFingerprint: string,
    knowledgeEpoch: number,
    responseContent: string,
    citations: any | null,
    modelName: string | null,
    processingTrace: any | null = null,
  ): Promise<void> {
    if (!this.enabled || !responseContent?.trim()) return;

    try {
      const embedding = queryEmbedding || (await this.getEmbedding(queryText));
      if (!embedding) return;

      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + this.ttlHours);

      // Dedupe: keep only the newest entry per (scope, question) so a re-run
      // after retrieval improvements deterministically replaces stale answers
      // instead of racing them on equal similarity.
      await this.prisma.$executeRaw`
        DELETE FROM "SemanticCache"
        WHERE "scopeFingerprint" = ${scopeFingerprint} AND "queryText" = ${queryText}
      `;
      // scopeFingerprint already encodes the exact selected source set plus the
      // ACL/knowledge epochs (see semanticCacheScopeKey). Mirror it into
      // cacheFingerprint for the DB-level index and forward compatibility.
      await this.prisma.$executeRaw`
        INSERT INTO "SemanticCache" (
          "queryText", "queryEmbedding", "scopeFingerprint", "knowledgeEpoch", 
          "responseContent", "citations", "processingTrace", "modelName", "expiresAt",
          "cacheFingerprint"
        ) VALUES (
          ${queryText}, ${embedding}::vector, ${scopeFingerprint}, ${knowledgeEpoch},
          ${responseContent}, ${citations ? JSON.stringify(citations) : null}::jsonb, 
          ${processingTrace ? JSON.stringify(processingTrace) : null}::jsonb, 
          ${modelName}, ${expiresAt}, ${scopeFingerprint}
        )
      `;
      this.logger.debug(`Stored semantic cache for query: ${queryText.substring(0, 50)}...`);
    } catch (err) {
      this.logger.error(`Store error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async invalidateByEpoch(scopeFingerprint: string, knowledgeEpoch: number): Promise<void> {
    try {
      await this.prisma.semanticCache.deleteMany({
        where: {
          scopeFingerprint,
          knowledgeEpoch: { lt: knowledgeEpoch },
        },
      });
      this.logger.log(`Invalidated semantic cache for scope ${scopeFingerprint} below epoch ${knowledgeEpoch}`);
    } catch (err) {
      this.logger.error(`Invalidate error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async cleanup(): Promise<void> {
    try {
      const result = await this.prisma.semanticCache.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
        },
      });
      if (result.count > 0) {
        this.logger.log(`Cleaned up ${result.count} expired semantic cache entries`);
      }
    } catch (err) {
      this.logger.error(`Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
