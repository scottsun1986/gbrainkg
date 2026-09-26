import { recordFailopen } from '../observability/failopen';
import { Injectable, Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { EmbeddingService, HybridEmbedding } from '../embedding/embedding.service';
import { withServiceContext } from '../db/tenant-context.service';

export interface HybridChunkHit {
  id: string;
  documentId: string;
  kbId: string;
  ord: number;
  content: string;
  metadata: any;
  document: { title: string; version: number };
  sparseScore: number;
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

/** ColBERT MaxSim: each query token selects its best document-token match. */
export function lateInteractionScore(queryVectors: number[][], documentVectors: number[][]): number {
  if (!queryVectors.length || !documentVectors.length) return 0;
  let total = 0;
  let valid = 0;
  for (const queryVector of queryVectors) {
    let best = -1;
    for (const documentVector of documentVectors) {
      best = Math.max(best, cosine(queryVector, documentVector));
    }
    if (best > -1) {
      total += best;
      valid += 1;
    }
  }
  return valid ? total / valid : 0;
}

@Injectable()
export class HybridRetrievalService {
  private readonly logger = new Logger(HybridRetrievalService.name);
  private readonly prisma = getPrismaClient();
  private readonly queryCache = new Map<string, { expiresAt: number; value: HybridEmbedding | null }>();

  constructor(private readonly embeddingService: EmbeddingService) {}

  isEnabled(): boolean {
    return this.embeddingService.isHybridEnabled();
  }

  private async queryRepresentation(query: string): Promise<HybridEmbedding | null> {
    const key = query.trim();
    const cached = this.queryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.embeddingService.embedHybridOne(query, 'query');
    this.queryCache.set(key, { expiresAt: Date.now() + 60_000, value });
    if (this.queryCache.size > 200) this.queryCache.delete(this.queryCache.keys().next().value as string);
    return value;
  }

  async searchSparse(kbIds: string[], query: string, limit = 50): Promise<HybridChunkHit[]> {
    if (!this.isEnabled() || !kbIds.length || !query.trim()) return [];
    const representation = await this.queryRepresentation(query);
    if (!representation?.sparse?.indices.length) {
      // Feature is on but no sparse arm came back (no endpoint, dense-only
      // gateway, or transient provider failure): fail open to dense+BM25 and
      // surface the degradation instead of silently dropping the channel.
      recordFailopen('sparse');
      return [];
    }
    try {
      const sparseIndices: number[] = representation.sparse!.indices;
      const sparseWeights: number[] = representation.sparse!.values;
      const rows = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<Array<{
        chunkId: string; sparseScore: number; documentId: string; kbId: string;
        ord: number; content: string; metadata: any; docTitle: string; docVersion: number;
      }>>`
        WITH query_terms AS (
          SELECT token_id, SUM(query_weight)::float8 AS query_weight
          FROM unnest(${sparseIndices}::integer[], ${sparseWeights}::real[]) AS q(token_id, query_weight)
          GROUP BY token_id
        ), ranked AS (
          SELECT s."chunkId", SUM(s.weight * q.query_weight)::float8 AS score
          FROM query_terms q
          JOIN "ChunkSparseEmbedding" s ON s."tokenId" = q.token_id
          JOIN "Chunk" c ON c.id = s."chunkId"
          JOIN "Document" d ON d.id = c."documentId"
          WHERE c."kbId" = ANY(${kbIds}::uuid[]) AND d.status = 'published'
          GROUP BY s."chunkId"
          ORDER BY score DESC
          LIMIT ${Math.max(1, limit)}
        )
        SELECT ranked."chunkId", ranked.score AS "sparseScore",
               c."documentId", c."kbId", c.ord, c.content, c.metadata,
               d.title AS "docTitle", d.version AS "docVersion"
        FROM ranked
        JOIN "Chunk" c ON c.id = ranked."chunkId"
        JOIN "Document" d ON d.id = c."documentId"
        ORDER BY ranked.score DESC
      `);
      return (rows || []).map((row: {
        chunkId: string; sparseScore: number; documentId: string; kbId: string;
        ord: number; content: string; metadata: any; docTitle: string; docVersion: number;
      }) => ({
        id: String(row.chunkId),
        documentId: row.documentId,
        kbId: row.kbId,
        ord: row.ord,
        content: row.content,
        metadata: row.metadata,
        document: { title: row.docTitle, version: row.docVersion },
        sparseScore: Number(row.sparseScore),
      }));
    } catch (err) {
      this.logger.debug(`BGE-M3 sparse retrieval unavailable: ${err instanceof Error ? err.message : String(err)}`);
      recordFailopen('sparse');
      return [];
    }
  }

  async rerankLateInteraction(query: string, candidateIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.isEnabled() || !candidateIds.length) return result;
    const representation = await this.queryRepresentation(query);
    if (!representation?.multiVector?.length) {
      // No ColBERT arm (missing endpoint / dense-only gateway): fail open and
      // let the caller keep the un-reordered candidate order.
      recordFailopen('late_interaction');
      return result;
    }
    const cappedIds = candidateIds.slice(0, Math.max(1, Number(process.env.BGE_M3_LATE_INTERACTION_CANDIDATES || 60)));
    try {
      const rows = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<Array<{ id: string; multiVector: unknown }>>`
        SELECT id, multi_vector AS "multiVector"
        FROM "Chunk"
        WHERE id = ANY(${cappedIds}::uuid[]) AND multi_vector IS NOT NULL
      `);
      for (const row of rows || []) {
        const vectors = Array.isArray(row.multiVector)
          ? (row.multiVector as unknown[]).filter(Array.isArray).map((vector: any) => vector.map(Number))
          : [];
        const score = lateInteractionScore(representation.multiVector, vectors);
        if (Number.isFinite(score) && score > 0) result.set(String(row.id), score);
      }
      return result;
    } catch (err) {
      this.logger.debug(`BGE-M3 late interaction unavailable: ${err instanceof Error ? err.message : String(err)}`);
      recordFailopen('late_interaction');
      return result;
    }
  }
}
