import { validateHybridCapability } from './hybrid-capability';
import { admitModelCall } from '../retrieval/model-admission';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelConfigService } from '../model-config.service';
import { createHash } from 'node:crypto';
import { embeddingFingerprint, reusableEmbeddingIdentity } from './model-fingerprint';
import { requestFetch, requestSignal } from '../retrieval/request-signal';
import { rethrowAuthorizationFailure } from '../permission/authorization-revision';

export interface EmbeddingProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  dimensions: number | null;
  deploymentRevision?: string;
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

  onModuleInit(): void {
    if (process.env.CORE_VERSIONING_ENABLED === '1' && (this.isHybridEnabled() || process.env.BGE_M3_MAXSIM_ENABLED === 'true')) {
      throw new Error('CORE_VERSIONING_ENABLED does not support BGE-M3 sparse/multi-vector indexes; disable BGE_M3_HYBRID_ENABLED and BGE_M3_MAXSIM_ENABLED');
    }
  }

  private cacheKey(config: EmbeddingProviderConfig, text: string): string {
    // Model names are not globally unique. Include the route and dimensions so
    // a provider/model migration cannot reuse vectors from an incompatible
    // embedding space.
    const route = embeddingFingerprint(config);
    const textHash = createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
    return `${route}:${textHash}`;
  }

  isEnabled(): boolean {
    return process.env.CHUNK_EMBEDDINGS_ENABLED !== 'false';
  }

  /**
   * Experimental sparse and late-interaction arms are independently opt-in.
   */
  isHybridEnabled(): boolean {
    return process.env.BGE_M3_HYBRID_ENABLED === 'true';
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
        deploymentRevision: process.env.EMBEDDING_DEPLOYMENT_REVISION,
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
    const cached = reusableEmbeddingIdentity(config) ? this.cache.get(cacheKey) : undefined;
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
        if (result && reusableEmbeddingIdentity(config)) {
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
  async embed(texts: string[], pinnedConfig?: EmbeddingProviderConfig): Promise<Array<number[] | null>> {
    if (!texts.length) return [];
    const config = pinnedConfig ?? await this.getConfig();
    if (!config) return texts.map(() => null);

    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    const now = Date.now();
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const cacheKey = this.cacheKey(config, text);
      const cached = reusableEmbeddingIdentity(config) ? this.cache.get(cacheKey) : undefined;
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
        if (vec && reusableEmbeddingIdentity(config)) {
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
    if (options.lateChunking) throw new Error('Late chunking requires a verified shared-context/offset contract; independent text input is unsupported');
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
      const revision=process.env.BGE_M3_HYBRID_DEPLOYMENT_REVISION || config?.deploymentRevision || '';
      const capabilityResponse=await requestFetch(process.env.BGE_M3_CAPABILITIES_ENDPOINT || `${config?.baseUrl || ''}/capabilities`,{ headers:config?.apiKey ? { Authorization:`Bearer ${config.apiKey}` }:{} },3000);
      if (!capabilityResponse.ok) throw new Error('Hybrid capability unavailable');
      const capability=validateHybridCapability(await capabilityResponse.json(),config?.modelName || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',revision,config?.dimensions || 1024,process.env.BGE_M3_MAXSIM_ENABLED==='true');
      const response = await requestFetch(endpoint, {
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
          return_colbert_vecs: process.env.BGE_M3_MAXSIM_ENABLED === 'true',
          late_chunking: false,
        }),
      }, Number(process.env.BGE_M3_HYBRID_TIMEOUT_MS || this.timeoutMs));
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
        const dense = Array.isArray(rawDense) && rawDense.every((v: unknown) => Number.isFinite(Number(v)))
          ? rawDense.map(Number) : null;
        const rawSparse = item.sparse_embedding ?? item.sparse ?? item.lexical_weights;
        let sparse: SparseEmbedding | null = null;
        if (rawSparse && Array.isArray(rawSparse.indices) && Array.isArray(rawSparse.values)) {
          const pairs = rawSparse.indices
            .map((tokenId: unknown, pairIndex: number) => ({ tokenId: Number(tokenId), value: Number(rawSparse.values[pairIndex]) }))
            .filter((pair: any) => Number.isInteger(pair.tokenId) && pair.tokenId>=0 && pair.tokenId<capability.vocabSize && Number.isFinite(pair.value) && pair.value>0);
          sparse = { indices: pairs.map((pair: any) => pair.tokenId), values: pairs.map((pair: any) => pair.value) };
        } else if (rawSparse && typeof rawSparse === 'object') {
          const pairs = Object.entries(rawSparse)
            .map(([tokenId, value]) => ({ tokenId: Number(tokenId), value: Number(value) }))
            .filter((pair) => Number.isInteger(pair.tokenId) && pair.tokenId>=0 && pair.tokenId<capability.vocabSize && Number.isFinite(pair.value) && pair.value>0);
          sparse = { indices: pairs.map((pair) => pair.tokenId), values: pairs.map((pair) => pair.value) };
        }
        const rawMulti = item.colbert_vecs ?? item.multi_vector ?? item.token_embeddings;
        const multiVector = Array.isArray(rawMulti)
          ? rawMulti.slice(0, maxTokenVectors)
              .filter(Array.isArray)
              .map((vector: unknown[]) => vector.map(Number))
              .filter((vector: number[]) => vector.length === capability.tokenDimensions && vector.every(Number.isFinite))
          : null;
        output[index] = {
          dense: dense && dense.length && (!config?.dimensions || dense.length === config.dimensions) ? dense : null,
          sparse: sparse?.indices.length ? sparse : null,
          multiVector: process.env.BGE_M3_MAXSIM_ENABLED==='true' && multiVector?.length ? multiVector : null,
        };
      }
      return output;
    } catch (err) {
      rethrowAuthorizationFailure(err);
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
      const cancellation = requestSignal(this.timeoutMs);
      try {
        if (cancellation.signal.aborted) throw cancellation.signal.reason;
        await admitModelCall(config.baseUrl,config.modelName,Math.ceil(inputs.reduce((sum,text) => sum+text.length,0)/3));
        const response = await fetch(`${config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: config.modelName, input: inputs }),
          signal: cancellation.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: any = await response.json();
        const data = Array.isArray(payload?.data) ? payload.data : [];
        const output: Array<number[] | null> = new Array(batch.length).fill(null);
        for (let i = 0; i < data.length; i++) {
          const item = data[i];
          const embedding = Array.isArray(item?.embedding) ? item.embedding.map(Number) : null;
          const index = Number.isInteger(item?.index) ? item.index : i;
          if (embedding && embedding.every(Number.isFinite) && embedding.length > 0 && index >= 0 && index < output.length) {
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
        rethrowAuthorizationFailure(err);
        if (cancellation.signal.aborted) throw err;
        if (attempt === 1) {
          this.logger.warn(
            `Embedding batch failed (${batch.length} inputs): ${err instanceof Error ? err.message : String(err)}`,
          );
          void import('../observability/failopen').then(({ recordFailopen }) => recordFailopen('embedding_batch')).catch(() => undefined);
          return new Array(batch.length).fill(null);
        }
      } finally { cancellation.dispose(); }
    }
    return new Array(batch.length).fill(null);
  }
}
