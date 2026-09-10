import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelConfigService } from '../model-config.service';

export interface EmbeddingProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  dimensions: number | null;
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

  constructor(@Optional() private readonly modelConfigService?: ModelConfigService) {}

  isEnabled(): boolean {
    return process.env.CHUNK_EMBEDDINGS_ENABLED !== 'false';
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

  /** Embed a single text. Returns null on any failure (fail-open). */
  async embedOne(text: string): Promise<number[] | null> {
    const [result] = await this.embed([text]);
    return result ?? null;
  }

  /**
   * Embed a list of texts in bounded batches. Always returns an array aligned
   * to the input; entries that fail are null. Never throws.
   */
  async embed(texts: string[]): Promise<Array<number[] | null>> {
    if (!texts.length) return [];
    const config = await this.getConfig();
    if (!config) return texts.map(() => null);

    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const batchResult = await this.embedBatch(batch, config);
      for (let i = 0; i < batchResult.length; i++) {
        results[start + i] = batchResult[i];
      }
    }
    return results;
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
              this.logger.warn(
                `Embedding dimension mismatch: got ${embedding.length}, expected ${config.dimensions}. Skipping batch.`,
              );
              return output;
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
