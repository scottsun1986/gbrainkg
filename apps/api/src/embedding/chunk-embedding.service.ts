import { Injectable, Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { EmbeddingService } from './embedding.service';

export interface EmbedDocumentChunksResult {
  requested: number;
  embedded: number;
  failed: number;
  missing: number;
}

/**
 * Populates and maintains Chunk.embedding for chunk-level semantic retrieval.
 *
 * The embedding column and its HNSW index are created by the
 * add_search_indexes migration; Prisma does not model the pgvector type, so
 * reads/writes go through raw SQL here.
 */
@Injectable()
export class ChunkEmbeddingService {
  private readonly logger = new Logger(ChunkEmbeddingService.name);
  private readonly prisma = getPrismaClient();
  private readonly writeBatchSize = Math.max(1, Number(process.env.CHUNK_EMBEDDING_WRITE_BATCH || 64));
  private readonly readBatchSize = Math.max(1, Number(process.env.CHUNK_EMBEDDING_READ_BATCH || 64));

  constructor(private readonly embeddingService: EmbeddingService) {}

  isEnabled(): boolean {
    return this.embeddingService.isEnabled();
  }

  /**
   * Embed every chunk of a document that does not yet have an embedding.
   * Cursor-paginates over `ord` (unique and sequential per document) so the
   * tail of very long documents is not silently truncated; callers use the
   * returned counts to gate readiness instead of swallowing null results.
   */
  async embedDocumentChunks(documentId: string): Promise<EmbedDocumentChunksResult> {
    let requested = 0;
    let embedded = 0;
    let failed = 0;
    let cursor = -1;
    for (;;) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; ord: number; content: string }>>`
        SELECT id, ord, content
        FROM "Chunk"
        WHERE "documentId" = ${documentId}::uuid AND embedding IS NULL AND ord > ${cursor}
        ORDER BY ord ASC
        LIMIT ${this.readBatchSize}
      `;
      if (!rows.length) break;
      cursor = rows[rows.length - 1].ord;
      requested += rows.length;
      const outcome = await this.embedAndStore(rows);
      embedded += outcome.stored;
      failed += outcome.failed;
      if (rows.length < this.readBatchSize) break;
    }
    const coverage = await this.documentCoverage(documentId);
    const result: EmbedDocumentChunksResult = {
      requested,
      embedded,
      failed,
      missing: coverage.missing,
    };
    if (failed || result.missing) {
      this.logger.warn(
        `Chunk embedding for ${documentId}: requested=${requested} embedded=${embedded} failed=${failed} missing=${result.missing}/${coverage.total}`,
      );
    }
    return result;
  }

  /**
   * Per-document embedding coverage for readiness gates: how many chunks
   * exist and how many required chunks still lack a vector.
   */
  async documentCoverage(documentId: string): Promise<{ total: number; missing: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint; missing: bigint }>>`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE embedding IS NULL)::bigint AS missing
      FROM "Chunk"
      WHERE "documentId" = ${documentId}::uuid
    `;
    const row = rows[0];
    return { total: Number(row?.total || 0), missing: Number(row?.missing || 0) };
  }

  /**
   * Backfill chunks missing embeddings across the corpus. `kbIds` narrows the
   * scope; `limit` bounds a single invocation so it can be called repeatedly.
   */
  async backfill(options: { kbIds?: string[]; limit?: number } = {}): Promise<{
    requested: number;
    embedded: number;
    failed: number;
  }> {
    const limit = Math.max(1, Math.min(Number(options.limit || 500), 5000));
    const kbIds = options.kbIds?.filter(Boolean) || [];
    const rows = kbIds.length
      ? await this.prisma.$queryRaw<Array<{ id: string; content: string }>>`
          SELECT c.id, c.content
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE c.embedding IS NULL AND d.status = 'published' AND c."kbId" = ANY(${kbIds}::uuid[])
          ORDER BY c."documentId", c.ord
          LIMIT ${limit}
        `
      : await this.prisma.$queryRaw<Array<{ id: string; content: string }>>`
          SELECT c.id, c.content
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE c.embedding IS NULL AND d.status = 'published'
          ORDER BY c."documentId", c.ord
          LIMIT ${limit}
        `;
    if (!rows.length) return { requested: 0, embedded: 0, failed: 0 };
    const outcome = await this.embedAndStore(rows);
    return { requested: rows.length, embedded: outcome.stored, failed: rows.length - outcome.stored };
  }

  private async embedAndStore(
    rows: Array<{ id: string; content: string }>,
  ): Promise<{ stored: number; failed: number }> {
    let stored = 0;
    let failed = 0;
    for (let start = 0; start < rows.length; start += this.writeBatchSize) {
      const slice = rows.slice(start, start + this.writeBatchSize);
      let vectors = await this.embeddingService.embed(slice.map((r) => r.content));
      // One retry for inputs whose first attempt produced no vector, so a
      // transient provider blip does not strand chunks until the next job.
      const missingAfterFirst: number[] = [];
      for (let i = 0; i < slice.length; i++) {
        if (!vectors[i] || !vectors[i]!.length) missingAfterFirst.push(i);
      }
      if (missingAfterFirst.length) {
        const retry = await this.embeddingService.embed(missingAfterFirst.map((i) => slice[i].content));
        missingAfterFirst.forEach((rowIndex, k) => {
          vectors[rowIndex] = retry[k] ?? vectors[rowIndex];
        });
      }
      for (let i = 0; i < slice.length; i++) {
        const vector = vectors[i];
        if (!vector || !vector.length) {
          failed += 1;
          continue;
        }
        try {
          const literal = `[${vector.join(',')}]`;
          await this.prisma.$executeRaw`
            UPDATE "Chunk" SET embedding = ${literal}::vector WHERE id = ${slice[i].id}::uuid
          `;
          stored += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `Failed to store embedding for chunk ${slice[i].id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (stored) this.logger.log(`Stored ${stored}/${rows.length} chunk embeddings.`);
    return { stored, failed };
  }

  async coverage(): Promise<{ total: number; embedded: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint; embedded: bigint }>>`
      SELECT COUNT(*)::bigint AS total, COUNT(embedding)::bigint AS embedded FROM "Chunk"
    `;
    const row = rows[0];
    return { total: Number(row?.total || 0), embedded: Number(row?.embedded || 0) };
  }
}
