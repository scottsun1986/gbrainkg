import { Injectable, Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { EmbeddingService } from './embedding.service';

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

  constructor(private readonly embeddingService: EmbeddingService) {}

  isEnabled(): boolean {
    return this.embeddingService.isEnabled();
  }

  /**
   * Embed every chunk of a document that does not yet have an embedding.
   * Called fire-and-forget after ingestion so indexing latency is unaffected.
   */
  async embedDocumentChunks(documentId: string, maxChunks = 400): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; content: string }>>`
      SELECT id, content
      FROM "Chunk"
      WHERE "documentId" = ${documentId}::uuid AND embedding IS NULL
      ORDER BY ord ASC
      LIMIT ${maxChunks}
    `;
    if (!rows.length) return 0;
    return this.embedAndStore(rows);
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
    const embedded = await this.embedAndStore(rows);
    return { requested: rows.length, embedded, failed: rows.length - embedded };
  }

  private async embedAndStore(rows: Array<{ id: string; content: string }>): Promise<number> {
    let stored = 0;
    for (let start = 0; start < rows.length; start += this.writeBatchSize) {
      const slice = rows.slice(start, start + this.writeBatchSize);
      const vectors = await this.embeddingService.embed(slice.map((r) => r.content));
      for (let i = 0; i < slice.length; i++) {
        const vector = vectors[i];
        if (!vector || !vector.length) continue;
        try {
          const literal = `[${vector.join(',')}]`;
          await this.prisma.$executeRaw`
            UPDATE "Chunk" SET embedding = ${literal}::vector WHERE id = ${slice[i].id}::uuid
          `;
          stored += 1;
        } catch (err) {
          this.logger.warn(
            `Failed to store embedding for chunk ${slice[i].id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (stored) this.logger.log(`Stored ${stored}/${rows.length} chunk embeddings.`);
    return stored;
  }

  async coverage(): Promise<{ total: number; embedded: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint; embedded: bigint }>>`
      SELECT COUNT(*)::bigint AS total, COUNT(embedding)::bigint AS embedded FROM "Chunk"
    `;
    const row = rows[0];
    return { total: Number(row?.total || 0), embedded: Number(row?.embedded || 0) };
  }
}
