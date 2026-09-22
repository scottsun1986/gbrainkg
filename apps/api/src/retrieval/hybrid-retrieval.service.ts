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
    if (!representation?.sparse?.indices.length) return [];
    const queryWeights = new Map<number, number>();
    representation.sparse.indices.forEach((tokenId, index) => {
      queryWeights.set(tokenId, Number(representation.sparse!.values[index]) || 0);
    });
    try {
      const postingLimit = Math.max(limit * 100, Number(process.env.BGE_M3_SPARSE_POSTING_LIMIT || 20_000));
      // Capture before the SQL closure: TS drops property narrowing inside callbacks.
      const sparseIndices: number[] = representation.sparse!.indices;
      const rows = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<Array<{
        chunkId: string; tokenId: number; weight: number; documentId: string; kbId: string;
        ord: number; content: string; metadata: any; docTitle: string; docVersion: number;
      }>>`
        SELECT s."chunkId", s."tokenId", s.weight,
               c."documentId", c."kbId", c.ord, c.content, c.metadata,
               d.title AS "docTitle", d.version AS "docVersion"
        FROM "ChunkSparseEmbedding" s
        JOIN "Chunk" c ON c.id = s."chunkId"
        JOIN "Document" d ON d.id = c."documentId"
        WHERE s."tokenId" = ANY(${sparseIndices}::integer[])
          AND c."kbId" = ANY(${kbIds}::uuid[])
          AND d.status = 'published'
        ORDER BY s.weight DESC
        LIMIT ${postingLimit}
      `);
      const scored = new Map<string, { score: number; row: typeof rows[number] }>();
      for (const row of rows || []) {
        const contribution = (queryWeights.get(Number(row.tokenId)) || 0) * Number(row.weight || 0);
        const current = scored.get(String(row.chunkId));
        if (current) current.score += contribution;
        else scored.set(String(row.chunkId), { score: contribution, row });
      }
      return [...scored.entries()]
        .map(([id, entry]) => ({
          id,
          documentId: entry.row.documentId,
          kbId: entry.row.kbId,
          ord: entry.row.ord,
          content: entry.row.content,
          metadata: entry.row.metadata,
          document: { title: entry.row.docTitle, version: entry.row.docVersion },
          sparseScore: entry.score,
        }))
        .sort((left, right) => right.sparseScore - left.sparseScore)
        .slice(0, Math.max(1, limit));
    } catch (err) {
      this.logger.debug(`BGE-M3 sparse retrieval unavailable: ${err instanceof Error ? err.message : String(err)}`);
      recordFailopen("hybrid");
      return [];
    }
  }

  async rerankLateInteraction(query: string, candidateIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.isEnabled() || !candidateIds.length) return result;
    const representation = await this.queryRepresentation(query);
    if (!representation?.multiVector?.length) return result;
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
      return result;
    }
  }
}
