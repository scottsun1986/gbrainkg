import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
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

  /**
   * Check if a vector literal is valid (no NaN/Infinity values).
   * PostgreSQL ::vector cast fails if any element is NaN or Infinity.
   * item.vec is a string like "[0.1,0.2,...]"
   */
  private isValidVectorLiteral(vecStr: string): boolean {
    // Parse the string representation of the vector
    const match = vecStr.match(/^\[(.*)\]$/);
    if (!match) return false;
    const elements = match[1].split(',').map((s) => parseFloat(s.trim()));
    return elements.length > 0 && elements.every((v) => Number.isFinite(v));
  }

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

      // Content-hash deduplication: check if identical text already has an
      // embedding in Chunk table. Matching runs on md5(content) so the query
      // hits the chunk_content_md5_idx expression index (gin_trgm cannot
      // serve equality); the SQL expression must stay byte-identical to the
      // index definition.
      const existingVecByContent = new Map<string, string>();
      try {
        const uniqueContents = Array.from(new Set(slice.map((r) => r.content))).filter(Boolean);
        if (uniqueContents.length > 0) {
          const contentByHash = new Map<string, string>();
          for (const content of uniqueContents) {
            contentByHash.set(createHash('md5').update(content).digest('hex'), content);
          }
          const hashes = Array.from(contentByHash.keys());
          const cached = await this.prisma.$queryRaw<Array<{ hash: string; vec: string }>>`
            SELECT DISTINCT ON (md5(content)) md5(content) AS hash, embedding::text as vec
            FROM "Chunk"
            WHERE md5(content) = ANY(${hashes}::text[]) AND embedding IS NOT NULL
          `;
          for (const c of cached || []) {
            const content = c.hash ? contentByHash.get(c.hash) : undefined;
            if (content && c.vec) existingVecByContent.set(content, c.vec);
          }
        }
      } catch {
        // Fall back gracefully to full embedding
      }

      const neededIndices: number[] = [];
      const neededTexts: string[] = [];
      const toStore: Array<{ id: string; vec: string }> = [];

      for (let i = 0; i < slice.length; i++) {
        const existing = existingVecByContent.get(slice[i].content);
        if (existing) {
          toStore.push({ id: slice[i].id, vec: existing });
        } else {
          neededIndices.push(i);
          neededTexts.push(slice[i].content);
        }
      }

      if (neededTexts.length > 0) {
        let vectors = await this.embeddingService.embed(neededTexts);
        const missingAfterFirst: number[] = [];
        for (let i = 0; i < neededTexts.length; i++) {
          if (!vectors[i] || !vectors[i]!.length) missingAfterFirst.push(i);
        }
        if (missingAfterFirst.length) {
          const retry = await this.embeddingService.embed(missingAfterFirst.map((i) => neededTexts[i]));
          missingAfterFirst.forEach((neededIdx, k) => {
            vectors[neededIdx] = retry[k] ?? vectors[neededIdx];
          });
        }
        for (let k = 0; k < neededIndices.length; k++) {
          const origIdx = neededIndices[k];
          const vector = vectors[k];
          if (!vector || !vector.length) {
            failed += 1;
            continue;
          }
          const literal = `[${vector.join(',')}]`;
          toStore.push({ id: slice[origIdx].id, vec: literal });
        }
      }

      // High-performance batch vector write: executes a single SQL statement for the batch
      if (toStore.length > 0) {
        // 单个含 NaN/Infinity 的向量字面量会让整批 ::vector 转换失败，
        // 写库前先剔除非法条目并告警，只让合法向量进入批量 VALUES。
        const validStore = toStore.filter((item) => {
          if (this.isValidVectorLiteral(item.vec)) return true;
          failed += 1;
          this.logger.warn(
            `Dropped non-finite embedding vector for chunk ${item.id}; it will be retried on the next embedding pass.`,
          );
          return false;
        });
        let batchSaved = false;
        if (validStore.length > 0 && typeof (this.prisma as any).$executeRawUnsafe === 'function') {
          try {
            const values = validStore
              .map((item) => `('${item.id}'::uuid, '${item.vec}'::vector)`)
              .join(',');
            await this.prisma.$executeRawUnsafe(`
              UPDATE "Chunk" AS c
              SET embedding = v.vec
              FROM (VALUES ${values}) AS v(id, vec)
              WHERE c.id = v.id
            `);
            stored += validStore.length;
            batchSaved = true;
          } catch (batchErr) {
            this.logger.debug(
              `Batch vector update failed, falling back to per-row update: ${batchErr instanceof Error ? batchErr.message : String(batchErr)}`,
            );
          }
        }
        if (!batchSaved) {
          for (const item of validStore) {
            try {
              await this.prisma.$executeRaw`
                UPDATE "Chunk" SET embedding = ${item.vec}::vector WHERE id = ${item.id}::uuid
              `;
              stored += 1;
            } catch (err) {
              failed += 1;
              this.logger.warn(
                `Failed to store embedding for chunk ${item.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
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
