import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelConfigService } from '../model-config.service';
import { createHash } from 'node:crypto';

export interface EmbeddingProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  dimensions: number | null;
}

export interface SparseEmbedding {
  indices: number[];
  values: number[];
}

export interface HybridEmbedding {
  dense: number[] | null;
  sparse: SparseEmbedding | null;
  multiVector: number[][] | null;
}

/**
 * Thin, fail-open client for the configured OpenAI-compatible embedding
 * endpoint (BAAI/bge-m3 by default). Used to populate Chunk.embedding for
 * chunk-level semantic retrieval.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly batchSize = Math.max(1, Number(process.env.EMBEDDING_BATCH_SIZE || 32));
  private readonly maxChars = Math.max(200, Number(process.env.EMBEDDING_MAX_CHARS || 6000));
  private readonly timeoutMs = Math.max(1000, Number(process.env.EMBEDDING_TIMEOUT_MS || 20000));
  private readonly cache = new Map<string, { vector: number[]; expiresAt: number }>();
  private readonly maxCacheEntries = Math.max(100, Number(process.env.EMBEDDING_CACHE_MAX_ENTRIES || 5000));
  private readonly cacheTtlMs = Math.max(60000, Number(process.env.EMBEDDING_CACHE_TTL_MS || 3600000));
  private readonly inFlight = new Map<string, Promise<number[] | null>>();

  /**
   * Cache hit that refreshes recency. The Map is insertion-ordered, so
   * re-inserting on hit turns the eviction policy from FIFO (evict whatever was
   * written first, even if it is the hottest entry) into LRU.
   */
  private touchCache(key: string, entry: { vector: number[]; expiresAt: number }): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  constructor(@Optional() private readonly modelConfigService?: ModelConfigService) {}

  private cacheKey(config: EmbeddingProviderConfig, text: string): string {
    // Model names are not globally unique. Include the route and dimensions so
    // a provider/model migration cannot reuse vectors from an incompatible
    // embedding space.
    const route = `${config.baseUrl}|${config.modelName}|${config.dimensions ?? 'dynamic'}`;
    const textHash = createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
    return `${route}:${textHash}`;
  }

  isEnabled(): boolean {
    return process.env.CHUNK_EMBEDDINGS_ENABLED !== 'false';
  }

  /**
   * BGE-M3 sparse / late-interaction arms. Default ON: the sparse and
   * ColBERT paths are fail-open (missing endpoint or dense-only gateway
   * simply leaves those channels empty and records `recordFailopen`), so the
   * safe default is to try. Set `BGE_M3_HYBRID_ENABLED=false` to opt out.
   */
  isHybridEnabled(): boolean {
    return process.env.BGE_M3_HYBRID_ENABLED !== 'false';
  }

  /**
   * Whether a hybrid-capable endpoint is configured at all. Used by the
   * retrieval sparse/late arms to distinguish "feature disabled" from
   * "feature enabled but no endpoint" (the latter is a fail-open event).
   */
  hasHybridEndpoint(): boolean {
    if (process.env.BGE_M3_HYBRID_ENDPOINT) return true;
    return Boolean(process.env.EMBEDDING_BASE_URL);
  }

  async getConfig(): Promise<EmbeddingProviderConfig | null> {
    try {
      const config = await this.modelConfigService?.getDefault('embedding');
      if (!config) return null;
      const baseUrl = (config.provider.baseUrl || process.env.EMBEDDING_BASE_URL || '').replace(/\/$/, '');
      const apiKey = config.provider.apiKey || process.env.SILICONFLOW_API_KEY || '';
      if (!baseUrl) return null;
      return {
        baseUrl,
        apiKey,
        modelName: config.modelName || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
        dimensions: config.dimensions ?? Number(process.env.EMBEDDING_DIMENSIONS || 1024),
      };
    } catch {
      return null;
    }
  }

  /** Embed a single text with Singleflight deduplication and client-side caching. Returns null on any failure (fail-open). */
  async embedOne(text: string): Promise<number[] | null> {
    const config = await this.getConfig();
    if (!config) return null;
    const cacheKey = this.cacheKey(config, text);
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      this.touchCache(cacheKey, cached);
      return cached.vector;
    }

    const existingFlight = this.inFlight.get(cacheKey);
    if (existingFlight) {
      return existingFlight;
    }

    const flightPromise = (async () => {
      try {
        // Reuse the exact configuration that formed the cache/singleflight
        // key. Calling embed() here fetched configuration a second time, which
        // both doubled control-plane work and could mix routes during a model
        // migration.
        const [result] = await this.embedBatch([text], config);
        if (result) {
          this.touchCache(cacheKey, { vector: result, expiresAt: Date.now() + this.cacheTtlMs });
        }
        return result ?? null;
      } finally {
        this.inFlight.delete(cacheKey);
      }
    })();

    this.inFlight.set(cacheKey, flightPromise);
    return flightPromise;
  }

  /**
   * Embed a list of texts in bounded batches with client-side caching.
   * Always returns an array aligned to the input; entries that fail are null. Never throws.
   */
  async embed(texts: string[]): Promise<Array<number[] | null>> {
    if (!texts.length) return [];
    const config = await this.getConfig();
    if (!config) return texts.map(() => null);

    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    const now = Date.now();
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const cacheKey = this.cacheKey(config, text);
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        this.touchCache(cacheKey, cached);
        results[i] = cached.vector;
      } else {
        missingIndices.push(i);
        missingTexts.push(text);
      }
    }

    if (missingTexts.length === 0) {
      return results;
    }

    for (let start = 0; start < missingTexts.length; start += this.batchSize) {
      const batchTexts = missingTexts.slice(start, start + this.batchSize);
      const batchIndices = missingIndices.slice(start, start + this.batchSize);
      const batchResult = await this.embedBatch(batchTexts, config);
      for (let i = 0; i < batchResult.length; i++) {
        const vec = batchResult[i];
        results[batchIndices[i]] = vec;
        if (vec) {
          const cacheKey = this.cacheKey(config, batchTexts[i]);
          this.touchCache(cacheKey, { vector: vec, expiresAt: now + this.cacheTtlMs });
        }
      }
    }
    return results;
  }

  /**
   * BGE-M3 hybrid contract: dense, learned sparse and ColBERT-style token
   * vectors in one request. It is opt-in because many OpenAI-compatible
   * gateways expose BGE-M3 dense vectors only. Compatible providers may return
   * `sparse_embedding` as {indices, values} or a token-id/weight object, and
   * `colbert_vecs` / `multi_vector` for late interaction.
   */
  async embedHybrid(
    texts: string[],
    inputType: 'query' | 'document' = 'document',
    options: { lateChunking?: boolean } = {},
  ): Promise<HybridEmbedding[]> {
    if (!texts.length) return [];
    if (!this.isHybridEnabled()) {
      return texts.map(() => ({ dense: null, sparse: null, multiVector: null }));
    }
    const config = await this.getConfig();
    if (!config && !process.env.BGE_M3_HYBRID_ENDPOINT) {
      // No embedding route and no dedicated hybrid endpoint: fail open with
      // empty representations (dense+BM25 stays live) and count the event.
      const { recordFailopen } = await import('../observability/failopen');
      recordFailopen('sparse');
      return texts.map(() => ({ dense: null, sparse: null, multiVector: null }));
    }
    const endpoint = String(
      process.env.BGE_M3_HYBRID_ENDPOINT || `${config?.baseUrl || ''}/embeddings`,
    );
    if (!process.env.BGE_M3_HYBRID_ENDPOINT && !config?.baseUrl) {
      const { recordFailopen } = await import('../observability/failopen');
      recordFailopen('sparse');
      return texts.map(() => ({ dense: null, sparse: null, multiVector: null }));
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config?.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config?.modelName || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
          input: texts.map((text) => String(text || '').slice(0, this.maxChars)),
          input_type: inputType,
          return_dense: true,
          return_sparse: true,
          return_colbert_vecs: true,
          late_chunking: options.lateChunking === true,
        }),
        signal: AbortSignal.timeout(Number(process.env.BGE_M3_HYBRID_TIMEOUT_MS || this.timeoutMs)),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: any = await response.json();
      const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.embeddings) ? payload.embeddings : [];
      const output: HybridEmbedding[] = texts.map(() => ({ dense: null, sparse: null, multiVector: null }));
      const maxTokenVectors = Math.max(1, Number(process.env.BGE_M3_MULTI_VECTOR_MAX_TOKENS || 128));
      for (let position = 0; position < data.length; position += 1) {
        const item = data[position] || {};
        const index = Number.isInteger(item.index) ? item.index : position;
        if (index < 0 || index >= output.length) continue;
        const rawDense = item.embedding ?? item.dense_embedding ?? item.dense_vecs;
        const dense = Array.isArray(rawDense) ? rawDense.map(Number).filter(Number.isFinite) : null;
        const rawSparse = item.sparse_embedding ?? item.sparse ?? item.lexical_weights;
        let sparse: SparseEmbedding | null = null;
        if (rawSparse && Array.isArray(rawSparse.indices) && Array.isArray(rawSparse.values)) {
          const pairs = rawSparse.indices
            .map((tokenId: unknown, pairIndex: number) => ({ tokenId: Number(tokenId), value: Number(rawSparse.values[pairIndex]) }))
            .filter((pair: any) => Number.isInteger(pair.tokenId) && Number.isFinite(pair.value) && pair.value !== 0);
          sparse = { indices: pairs.map((pair: any) => pair.tokenId), values: pairs.map((pair: any) => pair.value) };
        } else if (rawSparse && typeof rawSparse === 'object') {
          const pairs = Object.entries(rawSparse)
            .map(([tokenId, value]) => ({ tokenId: Number(tokenId), value: Number(value) }))
            .filter((pair) => Number.isInteger(pair.tokenId) && Number.isFinite(pair.value) && pair.value !== 0);
          sparse = { indices: pairs.map((pair) => pair.tokenId), values: pairs.map((pair) => pair.value) };
        }
        const rawMulti = item.colbert_vecs ?? item.multi_vector ?? item.token_embeddings;
        const multiVector = Array.isArray(rawMulti)
          ? rawMulti.slice(0, maxTokenVectors)
              .filter(Array.isArray)
              .map((vector: unknown[]) => vector.map(Number))
              .filter((vector: number[]) => vector.length > 0 && vector.every(Number.isFinite))
          : null;
        output[index] = {
          dense: dense && dense.length && (!config?.dimensions || dense.length === config.dimensions) ? dense : null,
          sparse: sparse?.indices.length ? sparse : null,
          multiVector: multiVector?.length ? multiVector : null,
        };
      }
      return output;
    } catch (err) {
      this.logger.warn(`BGE-M3 hybrid embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      return texts.map(() => ({ dense: null, sparse: null, multiVector: null }));
    }
  }

  async embedHybridOne(text: string, inputType: 'query' | 'document' = 'query'): Promise<HybridEmbedding | null> {
    const [result] = await this.embedHybrid([text], inputType);
    return result && (result.dense || result.sparse || result.multiVector) ? result : null;
  }

  private async embedBatch(
    batch: string[],
    config: EmbeddingProviderConfig,
  ): Promise<Array<number[] | null>> {
    const inputs = batch.map((text) => String(text || '').slice(0, this.maxChars));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(`${config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: config.modelName, input: inputs }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: any = await response.json();
        const data = Array.isArray(payload?.data) ? payload.data : [];
        const output: Array<number[] | null> = new Array(batch.length).fill(null);
        for (let i = 0; i < data.length; i++) {
          const item = data[i];
          const embedding = Array.isArray(item?.embedding) ? item.embedding.map(Number) : null;
          const index = Number.isInteger(item?.index) ? item.index : i;
          if (embedding && embedding.length > 0 && index >= 0 && index < output.length) {
            if (config.dimensions && embedding.length !== config.dimensions) {
              // Skip the offending item only. Discarding the whole batch made a
              // single malformed vector cost a 32x retry and left 31 good
              // vectors unwritten (the caller then re-requested all of them).
              this.logger.warn(
                `Embedding dimension mismatch on item ${index}: got ${embedding.length}, expected ${config.dimensions}. Skipping that item only.`,
              );
              continue;
            }
            output[index] = embedding;
          }
        }
        return output;
      } catch (err) {
        if (attempt === 1) {
          this.logger.warn(
            `Embedding batch failed (${batch.length} inputs): ${err instanceof Error ? err.message : String(err)}`,
          );
          return new Array(batch.length).fill(null);
        }
      }
    }
    return new Array(batch.length).fill(null);
  }
}
