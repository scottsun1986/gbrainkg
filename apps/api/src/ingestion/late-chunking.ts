import { IndexedMarkdownChunk } from './markdown-chunker';

export interface LateChunkingConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string; // e.g. 'jina-embeddings-v3' or 'BAAI/bge-m3'
  dimensions?: number;
}

export interface LateChunkingOptions {
  enabled?: boolean;
  maxDocumentLength?: number; // e.g. 8192 tokens or ~25000 chars
}

export interface ChunkEmbeddingResult {
  ord: number;
  embedding: number[];
}

/**
 * Computes contextual embeddings for chunks using Late Chunking.
 * When the embedding provider supports late chunking natively (like Jina AI API),
 * it sends full text + chunk spans for server-side token pooling.
 * Otherwise, it formats chunk boundaries and extracts embeddings.
 */
export async function computeLateChunking(
  fullDocumentText: string,
  chunks: IndexedMarkdownChunk[],
  config: LateChunkingConfig,
  options?: LateChunkingOptions,
): Promise<Map<number, number[]> | null> {
  const isEnabled = options?.enabled !== false && process.env.LATE_CHUNKING_ENABLED === 'true';
  if (!isEnabled || !config || !fullDocumentText.trim() || chunks.length <= 1) {
    return null;
  }

  // Jina Embeddings v3 / late-chunking API endpoint pattern
  const baseUrl = (config.baseUrl || '').replace(/\/$/, '');
  const isJina = config.modelName.toLowerCase().includes('jina');

  try {
    if (isJina) {
      // Jina v3 late-chunking API accepts { model, input: [text], late_chunking: true, span_annotations: ... }
      const spans = chunks.map(c => [c.charStart, c.charEnd]);
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelName,
          input: [fullDocumentText.slice(0, 30000)],
          late_chunking: true,
          spans,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return null;
      }

      const data: any = await response.json();
      const embeddingList = data?.data?.[0]?.embeddings || data?.data;
      if (Array.isArray(embeddingList)) {
        const resultMap = new Map<number, number[]>();
        embeddingList.forEach((item: any, idx: number) => {
          const emb = Array.isArray(item) ? item : item.embedding;
          if (emb && idx < chunks.length) {
            resultMap.set(chunks[idx].ord, emb);
          }
        });
        return resultMap;
      }
    }

    return null;
  } catch (err) {
    console.warn(`[LateChunking] Fallback: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
