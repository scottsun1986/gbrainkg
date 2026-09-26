import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ModelConfigService } from '../model-config.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { withServiceContext } from '../db/tenant-context.service';
import { recordFailopen } from '../observability/failopen';

@Injectable()
export class SemanticCacheService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(SemanticCacheService.name);
  private readonly prisma = getPrismaClient();
  private readonly enabled = process.env.SEMANTIC_CACHE_ENABLED !== 'false';
  private readonly similarityThreshold = Number(process.env.SEMANTIC_CACHE_SIMILARITY || '0.96');
  private readonly ttlHours = Number(process.env.SEMANTIC_CACHE_TTL_HOURS || '24');
  private readonly l1ExactCache = new Map<string, { hit: any; expiresAt: number }>();
  private cleanupTimer?: NodeJS.Timeout;

  static normalizeQuery(text: string): string {
    return String(text || '')
      .toLowerCase()
      .replace(/[？?。！!,，\s\-_:："“”'‘’（）()【】\[\]、\/\\|`~@#$%^&*+=<>—…]+/g, ' ')
      .trim();
  }

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

    // L1 Fast-Path: Normalized exact match in-memory cache (0ms, 0 vector calls)
    const normalized = SemanticCacheService.normalizeQuery(queryText);
    const l1Key = `${scopeFingerprint}:${knowledgeEpoch}:${normalized}`;
    const l1Hit = this.l1ExactCache.get(l1Key);
    if (l1Hit && l1Hit.expiresAt > Date.now()) {
      this.logger.log(`Semantic cache L1 FAST HIT (normalized match, 0ms) for: ${queryText.substring(0, 50)}...`);
      // Refresh Map insertion order for LRU eviction
      this.l1ExactCache.delete(l1Key);
      this.l1ExactCache.set(l1Key, l1Hit);
      return l1Hit.hit;
    }

    try {
      const embedding = await this.getEmbedding(queryText);
      if (!embedding) return null;

      const results = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<any[]>`
        SELECT id, "queryText", "responseContent", citations, "processingTrace", "modelName",
               1 - ("queryEmbedding" <=> ${embedding}::vector) as similarity
        FROM "SemanticCache"
        WHERE "scopeFingerprint" = ${scopeFingerprint}
          AND "knowledgeEpoch" = ${knowledgeEpoch}
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          AND 1 - ("queryEmbedding" <=> ${embedding}::vector) > ${this.similarityThreshold}
        ORDER BY similarity DESC, "createdAt" DESC
        LIMIT 1
      `);

      if (Array.isArray(results) && results.length > 0) {
        const hit = (results as any[])[0];
        
        // Cache to L1 for subsequent instant zero-millisecond hits
        this.l1ExactCache.set(l1Key, {
          hit,
          expiresAt: Date.now() + this.ttlHours * 3600000,
        });

        // Async increment hitCount and update lastHitAt
        withServiceContext(this.prisma, (tx) =>
          tx.$executeRaw`
          UPDATE "SemanticCache"
          SET "hitCount" = "hitCount" + 1, "lastHitAt" = NOW()
          WHERE id = ${hit.id}
        `).catch(err => this.logger.error(`Failed to update hit count for ${hit.id}:`, err));

        this.logger.log(`Semantic cache HIT (similarity: ${hit.similarity}) for query: ${queryText.substring(0, 50)}...`);
        return hit;
      }

      this.logger.debug(`Semantic cache MISS for query: ${queryText.substring(0, 50)}...`);
      return null;
    } catch (err) {
      this.logger.error(`Lookup error: ${err instanceof Error ? err.message : String(err)}`);
      recordFailopen('semantic_cache');
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

      // Save to L1 cache immediately
      const normalized = SemanticCacheService.normalizeQuery(queryText);
      const l1Key = `${scopeFingerprint}:${knowledgeEpoch}:${normalized}`;
      const entryObj = {
        id: `l1-${Date.now()}`,
        queryText,
        responseContent,
        citations,
        processingTrace,
        modelName,
        similarity: 1.0,
        hitCount: 1,
      };
      this.l1ExactCache.set(l1Key, {
        hit: entryObj,
        expiresAt: expiresAt.getTime(),
      });
      if (this.l1ExactCache.size > 2000) {
        const oldest = this.l1ExactCache.keys().next().value;
        if (oldest) this.l1ExactCache.delete(oldest);
      }

      // scopeFingerprint already encodes the exact selected source set plus the
      // ACL/knowledge epochs (see semanticCacheScopeKey). Mirror it into
      // cacheFingerprint for the DB-level index and forward compatibility.
      await withServiceContext(this.prisma, (tx) =>
        tx.$executeRaw`
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
        ON CONFLICT ("scopeFingerprint", "queryText") DO UPDATE SET
          "queryEmbedding" = EXCLUDED."queryEmbedding",
          "knowledgeEpoch" = EXCLUDED."knowledgeEpoch",
          "responseContent" = EXCLUDED."responseContent",
          "citations" = EXCLUDED."citations",
          "processingTrace" = EXCLUDED."processingTrace",
          "modelName" = EXCLUDED."modelName",
          "expiresAt" = EXCLUDED."expiresAt",
          "cacheFingerprint" = EXCLUDED."cacheFingerprint",
          "hitCount" = 0,
          "createdAt" = CURRENT_TIMESTAMP,
          "lastHitAt" = NULL
      `);
      this.logger.debug(`Stored semantic cache for query: ${queryText.substring(0, 50)}...`);
    } catch (err) {
      this.logger.error(`Store error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Note: there is deliberately no `invalidateByEpoch` here any more. Epochs are
  // per-BrainScope counters, but the cache key is a hash of
  // (sources, aclEpoch, knowledgeEpoch, model, user), so bumping an epoch changes
  // the key: every pre-bump entry becomes unreachable by construction and is
  // reclaimed by `cleanup()` when its TTL expires. The previous method was dead
  // code (no callers) and could not have worked correctly anyway, because a
  // global "knowledgeEpoch < n" sweep would delete entries belonging to other
  // scopes whose unrelated counters happen to be smaller.

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
