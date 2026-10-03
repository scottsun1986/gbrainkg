import { rethrowAuthorizationFailure } from '../permission/authorization-revision';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ModelConfigService } from '../model-config.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { withServiceContext } from '../db/tenant-context.service';
import { recordFailopen } from '../observability/failopen';
import { getRequestContext } from '../observability/request-context';
import { authorizationEnforced } from '../permission/authorization-revision';
import { validateEvidenceDependencies } from '../permission/evidence-dependencies';
import { runAsService } from '../db/service-principal';

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
    // Symbols, case and internal whitespace can change meaning (C vs C++,
    // identifiers and quoted text). An exact cache must preserve them.
    return String(text || '').trim();
  }

  private remember(key: string, hit: any, expiresAt: number): void {
    this.l1ExactCache.delete(key);
    if (expiresAt <= Date.now()) return;
    this.l1ExactCache.set(key, { hit, expiresAt });
    while (this.l1ExactCache.size > 2000) {
      this.l1ExactCache.delete(this.l1ExactCache.keys().next().value!);
    }
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
      runAsService('cache-maintenance', () => this.cleanup()).catch(() => undefined);
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async lookup(
    queryText: string,
    scopeFingerprint: string,
    knowledgeEpoch: number,
    queryEmbedding?: number[] | null,
  ): Promise<any | null> {
    if (!this.enabled) return null;

    // L1 Fast-Path: Normalized exact match in-memory cache (0ms, 0 vector calls)
    const normalized = SemanticCacheService.normalizeQuery(queryText);
    const l1Key = `${scopeFingerprint}:${knowledgeEpoch}:${normalized}`;
    const l1Hit = this.l1ExactCache.get(l1Key);
    if (l1Hit && l1Hit.expiresAt > Date.now()) {
      if (authorizationEnforced() && !await validateEvidenceDependencies(getRequestContext()?.userId || '', l1Hit.hit.dependencyManifest)) {
        this.l1ExactCache.delete(l1Key); return null;
      }
      this.logger.log(`Semantic cache L1 FAST HIT (normalized match, 0ms) for: ${queryText.substring(0, 50)}...`);
      // Refresh Map insertion order for LRU eviction
      this.l1ExactCache.delete(l1Key);
      this.l1ExactCache.set(l1Key, l1Hit);
      return l1Hit.hit;
    }

    try {
      const results = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<any[]>`
        SELECT id, "queryText", "responseContent", citations, "dependencyManifest", "processingTrace", "modelName", "expiresAt", 1.0 AS similarity
        FROM "SemanticCache"
        WHERE "scopeFingerprint" = ${scopeFingerprint}
          AND "knowledgeEpoch" = ${knowledgeEpoch}
          AND "queryText" = ${normalized}
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        ORDER BY similarity DESC, "createdAt" DESC
        LIMIT 1
      `);

      let hit: any = Array.isArray(results) && results.length > 0 ? (results as any[])[0] : null;

      // B-5: vector near-match. The exact queryText match above only serves
      // byte-identical questions; reworded or near-synonymous questions all
      // missed. Fall back to pgvector cosine over the persisted
      // queryEmbedding column within the same scope fingerprint and knowledge
      // epoch, above the configured similarity threshold.
      if (!hit) {
        hit = await this.lookupByVectorSimilarity(queryText, scopeFingerprint, knowledgeEpoch, queryEmbedding);
      }

      if (hit) {
        if (authorizationEnforced() && !await validateEvidenceDependencies(getRequestContext()?.userId || '', hit.dependencyManifest)) return null;

        // Cache to L1 for subsequent instant zero-millisecond hits
        const localExpiry = Date.now() + this.ttlHours * 3600000;
        this.remember(l1Key, hit, hit.expiresAt
          ? Math.min(localExpiry, new Date(hit.expiresAt).getTime())
          : localExpiry);

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
    } catch (err) { rethrowAuthorizationFailure(err);
      this.logger.error(`Lookup error: ${err instanceof Error ? err.message : String(err)}`);
      recordFailopen('semantic_cache');
      return null;
    }
  }

  /**
   * Vector near-match lookup (B-5). Uses the caller-supplied query embedding
   * when retrieval already produced one; otherwise embeds the query lazily.
   * Corpus-agnostic by construction: similarity is pure vector cosine inside
   * the same scope/epoch bucket — no query rewriting, no synonym tables.
   */
  private async lookupByVectorSimilarity(
    queryText: string,
    scopeFingerprint: string,
    knowledgeEpoch: number,
    queryEmbedding?: number[] | null,
  ): Promise<any | null> {
    try {
      let embedding = Array.isArray(queryEmbedding) && queryEmbedding.length
        ? queryEmbedding
        : null;
      if (!embedding) {
        if (!this.embeddingService?.isEnabled?.()) return null;
        embedding = await this.embeddingService!.embedOne(queryText);
      }
      if (!embedding || !embedding.length) return null;
      const vectorLiteral = `[${embedding.join(',')}]`;
      const results = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<any[]>`
        SELECT id, "queryText", "responseContent", citations, "dependencyManifest", "processingTrace", "modelName", "expiresAt",
               1 - ("queryEmbedding" <=> ${vectorLiteral}::vector) AS similarity
        FROM "SemanticCache"
        WHERE "scopeFingerprint" = ${scopeFingerprint}
          AND "knowledgeEpoch" = ${knowledgeEpoch}
          AND "queryEmbedding" IS NOT NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
          AND 1 - ("queryEmbedding" <=> ${vectorLiteral}::vector) >= ${this.similarityThreshold}
        ORDER BY "queryEmbedding" <=> ${vectorLiteral}::vector ASC, "createdAt" DESC
        LIMIT 1
      `);
      return Array.isArray(results) && results.length > 0 ? results[0] : null;
    } catch (err) { rethrowAuthorizationFailure(err);
      this.logger.warn(`Vector similarity cache lookup failed: ${err instanceof Error ? err.message : String(err)}`);
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
    const dependencies = getRequestContext()?.evidenceDependencies;
    if (authorizationEnforced() && (!dependencies?.length || !await validateEvidenceDependencies(getRequestContext()?.userId || '', dependencies))) return;

    try {
      // Exact matching needs no extra model call. The nullable vector is only
      // retained when retrieval has already produced it.
      const embedding = queryEmbedding || null;

      const expiresAt = new Date(Math.min(Date.now() + this.ttlHours * 3600000,
        getRequestContext()?.authorization?.expiresAt ?? Infinity,
        ...(dependencies || []).flatMap(d => d.effectiveTo ? [Date.parse(d.effectiveTo)] : [])));

      // Save to L1 cache immediately
      const normalized = SemanticCacheService.normalizeQuery(queryText);
      const l1Key = `${scopeFingerprint}:${knowledgeEpoch}:${normalized}`;
      const entryObj = {
        id: `l1-${Date.now()}`,
        queryText,
        responseContent,
        citations,
        dependencyManifest: dependencies || null,
        processingTrace,
        modelName,
        similarity: 1.0,
        hitCount: 1,
      };
      this.remember(l1Key, entryObj, expiresAt.getTime());

      // scopeFingerprint already encodes the exact selected source set plus the
      // ACL/knowledge epochs (see semanticCacheScopeKey). Mirror it into
      // cacheFingerprint for the DB-level index and forward compatibility.
      await withServiceContext(this.prisma, (tx) =>
        tx.$executeRaw`
        INSERT INTO "SemanticCache" (
          "queryText", "queryEmbedding", "scopeFingerprint", "knowledgeEpoch",
          "responseContent", "citations", "processingTrace", "modelName", "expiresAt",
          "cacheFingerprint", "dependencyManifest"
        ) VALUES (
          ${normalized}, ${embedding}::vector, ${scopeFingerprint}, ${knowledgeEpoch},
          ${responseContent}, ${citations ? JSON.stringify(citations) : null}::jsonb,
          ${processingTrace ? JSON.stringify(processingTrace) : null}::jsonb,
          ${modelName}, ${expiresAt}, ${scopeFingerprint}, ${dependencies ? JSON.stringify(dependencies) : null}::jsonb
        )
        ON CONFLICT ("scopeFingerprint", "queryText") DO UPDATE SET
          "queryEmbedding" = EXCLUDED."queryEmbedding",
          "knowledgeEpoch" = EXCLUDED."knowledgeEpoch",
          "responseContent" = EXCLUDED."responseContent",
          "citations" = EXCLUDED."citations",
          "dependencyManifest" = EXCLUDED."dependencyManifest",
          "processingTrace" = EXCLUDED."processingTrace",
          "modelName" = EXCLUDED."modelName",
          "expiresAt" = EXCLUDED."expiresAt",
          "cacheFingerprint" = EXCLUDED."cacheFingerprint",
          "hitCount" = 0,
          "createdAt" = CURRENT_TIMESTAMP,
          "lastHitAt" = NULL
      `);
      this.logger.debug(`Stored semantic cache for query: ${queryText.substring(0, 50)}...`);
    } catch (err) { rethrowAuthorizationFailure(err);
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
    const now = Date.now();
    for (const [key, entry] of this.l1ExactCache) {
      if (entry.expiresAt <= now) this.l1ExactCache.delete(key);
    }
    try {
      const result = await this.prisma.semanticCache.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
        },
      });
      if (result.count > 0) {
        this.logger.log(`Cleaned up ${result.count} expired semantic cache entries`);
      }
    } catch (err) { rethrowAuthorizationFailure(err);
      this.logger.error(`Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
