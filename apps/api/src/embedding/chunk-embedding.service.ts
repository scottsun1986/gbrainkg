import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../prisma';
import { EmbeddingService } from './embedding.service';
import { indexableChunkText } from '../ingestion/chunk-text';
import { formatVectorValues, withServiceContext } from '../db/tenant-context.service';
import { embeddingFingerprint, hybridFingerprint, reusableEmbeddingIdentity } from './model-fingerprint';
import { positiveNumber } from '../config-numbers';

export interface EmbedDocumentChunksResult {
  requested: number;
  embedded: number;
  failed: number;
  missing: number;
  hybridMissing?: number;
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
  // A misspelled value must not become NaN: `Math.max(1, Number('8x'))` is NaN,
  // which reaches the SQL as `LIMIT NaN` and fails the whole pass.
  private readonly writeBatchSize = positiveNumber(process.env.CHUNK_EMBEDDING_WRITE_BATCH, 64);
  private readonly readBatchSize = positiveNumber(process.env.CHUNK_EMBEDDING_READ_BATCH, 64);

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
      const rows: any = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<Array<{ id: string; ord: number; content: string }>>`
        SELECT id, ord, content
        FROM "Chunk"
        WHERE "documentId" = ${documentId}::uuid AND embedding IS NULL AND ord > ${cursor}
        ORDER BY ord ASC
        LIMIT ${this.readBatchSize}
      `);
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
    if (embedded > 0) {
      const kbRows = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<Array<{ kbId: string }>>`
        SELECT "kbId" FROM "Document" WHERE id = ${documentId}::uuid
      `).catch(() => [] as Array<{ kbId: string }>);
      await this.recordEmbeddingModelState([kbRows?.[0]?.kbId]);
    }
    if (this.embeddingService.isHybridEnabled?.()) {
      await this.indexHybridDocument(documentId).catch((err) => {
        this.logger.warn(
          `BGE-M3 hybrid indexing failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (process.env.BGE_M3_HYBRID_ENDPOINT) {
        const rows: any = await withServiceContext(this.prisma, (tx) =>
          tx.$queryRaw<Array<{ missing: bigint }>>`
            SELECT COUNT(*) FILTER (WHERE hybrid_indexed = false)::bigint AS missing
            FROM "Chunk" WHERE "documentId" = ${documentId}::uuid
          `,
        );
        result.hybridMissing = Number(rows?.[0]?.missing || 0);
      }
    }
    return result;
  }

  /**
   * Populate learned sparse postings and ColBERT token vectors for one
   * document. Optional representations never overwrite the core dense space.
   * Independent strings are not a shared-context late-chunking contract.
   */
  async indexHybridDocument(documentId: string): Promise<{ requested: number; indexed: number }> {
    if (!this.embeddingService.isHybridEnabled?.()) return { requested: 0, indexed: 0 };
    const config = await this.embeddingService.getConfig?.();
    const fingerprint = config ? hybridFingerprint(config) : null;
    let indexed = 0;
    let requested = 0;
    let lastOrd = -1;
    while (true) {
      const slice = await withServiceContext(this.prisma, (tx) =>
        tx.$queryRaw<Array<{ id: string; content: string; ord: number }>>`
          SELECT c.id, c.content, c.ord FROM "Chunk" c
          WHERE c."documentId" = ${documentId}::uuid AND c.ord > ${lastOrd}
            AND (c.hybrid_indexed = false OR c.hybrid_fingerprint IS DISTINCT FROM ${fingerprint})
          ORDER BY c.ord ASC LIMIT ${this.readBatchSize}
        `);
      if (!slice.length) break;
      requested += slice.length;
      lastOrd = slice[slice.length - 1].ord;
      const representations = await this.embeddingService.embedHybrid(
        slice.map((row: any) => indexableChunkText(row.content)),
        'document',
        { lateChunking: false },
      );
      for (let index = 0; index < slice.length; index += 1) {
        const row = slice[index];
        const representation = representations[index];
        if (!representation) continue;
        const sparseRows = representation.sparse
          ? representation.sparse.indices.map((tokenId, pairIndex) => ({
              tokenId,
              weight: representation.sparse!.values[pairIndex],
            })).filter((entry) => Number.isInteger(entry.tokenId) && Number.isFinite(entry.weight))
          : [];
        try {
          await withServiceContext(this.prisma, async (tx) => {
            await (tx as any).$executeRaw`
              DELETE FROM "ChunkSparseEmbedding" WHERE "chunkId" = ${row.id}::uuid
            `;
            if (sparseRows.length) {
              const payload = JSON.stringify(sparseRows);
              await (tx as any).$executeRaw`
                INSERT INTO "ChunkSparseEmbedding" ("chunkId", "tokenId", weight)
                SELECT ${row.id}::uuid, p."tokenId", p.weight
                FROM jsonb_to_recordset(${payload}::jsonb) AS p("tokenId" integer, weight real)
                ON CONFLICT ("chunkId", "tokenId") DO UPDATE SET weight = EXCLUDED.weight
              `;
            }
            // Reuse the dense vector this same request already paid for.
            // The hybrid endpoint returns dense alongside sparse/multi-vector
            // (return_dense: true) over the identical indexable text, and the
            // dense arm stores the same vector from a second call. When a chunk
            // still lacks a vector (the embedding pass failed, or this document
            // was indexed before the dense route was configured), writing the
            // dense half here removes a whole second embedding pass per chunk
            // instead of discarding it. Only fills a gap: an existing vector is
            // never overwritten, so the two paths cannot disagree.
            const denseLiteral = representation.dense && representation.dense.length
              ? `[${representation.dense.join(',')}]`
              : null;
            await (tx as any).$executeRaw`
              UPDATE "Chunk"
              SET multi_vector = ${representation.multiVector ? JSON.stringify(representation.multiVector) : null}::jsonb,
                  late_context = false,
                  hybrid_indexed = ${Boolean(sparseRows.length)},
                  hybrid_fingerprint = ${fingerprint},
                  embedding = COALESCE(
                    embedding,
                    CASE WHEN ${denseLiteral}::text IS NULL THEN NULL ELSE ${denseLiteral}::text::vector END
                  ),
                  embedding_fingerprint = COALESCE(embedding_fingerprint, CASE WHEN ${denseLiteral}::text IS NULL THEN NULL ELSE ${fingerprint}::text END),
                  metadata = jsonb_set(
                    jsonb_set(COALESCE(metadata, '{}'::jsonb), '{canonical_block,retrieval,sparse}',
                      ${sparseRows.length > 0 ? 'true' : 'false'}::jsonb, true),
                    '{canonical_block,retrieval,multiVector}',
                    ${Boolean(representation.multiVector?.length) ? 'true' : 'false'}::jsonb, true
                  )
              WHERE id = ${row.id}::uuid
            `;
          });
          if (sparseRows.length) indexed += 1;
        } catch (err) {
          // Migration/provider rollout is fail-open: dense+BM25 remains live.
          this.logger.debug(
            `Hybrid representation write skipped for chunk ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { requested, indexed };
  }

  /**
   * Per-document embedding coverage for readiness gates: how many chunks
   * exist and how many required chunks still lack a vector.
   */
  async documentCoverage(documentId: string): Promise<{ total: number; missing: number }> {
    const rows: any = await withServiceContext(this.prisma, (tx) =>
      tx.$queryRaw<Array<{ total: bigint; missing: bigint }>>`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE embedding IS NULL)::bigint AS missing
      FROM "Chunk"
      WHERE "documentId" = ${documentId}::uuid
    `);
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
      ? await withServiceContext(this.prisma, (tx) =>
          tx.$queryRaw<Array<{ id: string; content: string }>>`
          SELECT c.id, c.content
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE c.embedding IS NULL AND d.status = 'published' AND c."kbId" = ANY(${kbIds}::uuid[])
          ORDER BY c."documentId", c.ord
          LIMIT ${limit}
        `)
      : await withServiceContext(this.prisma, (tx) =>
          tx.$queryRaw<Array<{ id: string; content: string }>>`
          SELECT c.id, c.content
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE c.embedding IS NULL AND d.status = 'published'
          ORDER BY c."documentId", c.ord
          LIMIT ${limit}
        `);
    if (!rows.length) return { requested: 0, embedded: 0, failed: 0 };
    const outcome = await this.embedAndStore(rows);
    if (outcome.stored > 0) {
      const kbRows = kbIds.length
        ? kbIds.map((kbId) => ({ kbId }))
        : (await withServiceContext(this.prisma, (tx) =>
            tx.$queryRaw<Array<{ kbId: string }>>`
            SELECT DISTINCT "kbId" FROM "Chunk" WHERE id = ANY(${rows.map((r: any) => r.id)}::uuid[])
          `).catch(() => [] as Array<{ kbId: string }>));
      await this.recordEmbeddingModelState((kbRows || []).map((row: any) => row.kbId));
    }
    return { requested: rows.length, embedded: outcome.stored, failed: rows.length - outcome.stored };
  }

  private async embedAndStore(
    rows: Array<{ id: string; content: string }>,
    table: 'Chunk' | 'BlockArtifact' = 'Chunk',
  ): Promise<{ stored: number; failed: number }> {
    let stored = 0;
    let failed = 0;
    const config = await this.embeddingService.getConfig?.();
    const fingerprint = config ? embeddingFingerprint(config) : null;
    for (let start = 0; start < rows.length; start += this.writeBatchSize) {
      const slice = rows.slice(start, start + this.writeBatchSize);

      // Content-hash deduplication: check if identical text already has an
      // embedding in Chunk table. Matching runs on md5(content) so the query
      // hits the chunk_content_md5_idx expression index (gin_trgm cannot
      // serve equality); the SQL expression must stay byte-identical to the
      // index definition.
      const existingVecByContent = new Map<string, string>();
      try {
        const uniqueContents = Array.from(new Set(slice.map((r: any) => r.content))).filter(Boolean);
        if (uniqueContents.length > 0 && fingerprint && config && reusableEmbeddingIdentity(config)) {
          const contentByHash = new Map<string, string>();
          for (const content of uniqueContents) {
            contentByHash.set(createHash('md5').update(content).digest('hex'), content);
          }
          const hashes = Array.from(contentByHash.keys());
          const cached = await withServiceContext(this.prisma, (tx) =>
            tx.$queryRaw<Array<{ hash: string; vec: string }>>`
            SELECT DISTINCT ON (md5(content)) md5(content) AS hash, embedding::text as vec
            FROM "Chunk"
            WHERE md5(content) = ANY(${hashes}::text[]) AND embedding IS NOT NULL
              AND embedding_fingerprint = ${fingerprint}
            UNION ALL
            SELECT DISTINCT ON (md5(content)) md5(content) AS hash, embedding::text as vec
            FROM "BlockArtifact" WHERE md5(content) = ANY(${hashes}::text[])
              AND embedding IS NOT NULL AND embedding_fingerprint = ${fingerprint}
          `);
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
          // Embed the document text without the chunker's structural
          // bookkeeping comments (see indexableChunkText). Dedup above stays
          // keyed on the raw content, and the projection is a pure function of
          // it, so md5(content) <=> embedding(indexable(content)) stays 1:1.
          neededTexts.push(indexableChunkText(slice[i].content));
        }
      }

      if (neededTexts.length > 0) {
        let vectors = config ? await this.embeddingService.embed(neededTexts, config)
          : await this.embeddingService.embed(neededTexts);
        const missingAfterFirst: number[] = [];
        for (let i = 0; i < neededTexts.length; i++) {
          if (!vectors[i] || !vectors[i]!.length) missingAfterFirst.push(i);
        }
        if (missingAfterFirst.length) {
          const retryTexts = missingAfterFirst.map((i) => neededTexts[i]);
          const retry = config ? await this.embeddingService.embed(retryTexts, config)
            : await this.embeddingService.embed(retryTexts);
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
        if (validStore.length > 0 && typeof (this.prisma as any).$executeRaw === 'function') {
          try {
            // formatVectorValues 校验每条 id 为 UUID、vec 为纯数值向量字面量，
            // 再以 Prisma.raw 注入已验证的 VALUES 片段。原先的 $executeRawUnsafe
            // 字符串拼接面已消除：这里走 $executeRaw + 严格校验过的批量 VALUES，
            // 仍是单语句批量写（64 行 → 1 条 UPDATE），性能语义不变。
            const values = formatVectorValues(validStore);
            await withServiceContext(this.prisma, (tx) =>
              (tx as any).$executeRaw`
              UPDATE ${Prisma.raw(`"${table}"`)} AS c
              SET embedding = v.vec, embedding_fingerprint = ${fingerprint}
                  ${Prisma.raw(table === 'Chunk' ? ", metadata = jsonb_set(COALESCE(c.metadata, '{}'::jsonb), '{canonical_block,retrieval,dense}', 'true'::jsonb, true)" : '')}
              FROM (VALUES ${Prisma.raw(values)}) AS v(id, vec)
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
              await withServiceContext(this.prisma, (tx) =>
                (tx as any).$executeRaw`
                UPDATE ${Prisma.raw(`"${table}"`)}
                SET embedding = ${item.vec}::vector, embedding_fingerprint = ${fingerprint}
                    ${Prisma.raw(table === 'Chunk' ? ", metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{canonical_block,retrieval,dense}', 'true'::jsonb, true)" : '')}
                WHERE id = ${item.id}::uuid
              `);
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

  async embedVersionArtifacts(versionId: string): Promise<{ fingerprint: string; missing: number }> {
    const config = await this.embeddingService.getConfig();
    if (!config) throw new Error('Embedding model configuration is required for publication');
    if (!reusableEmbeddingIdentity(config)) {
      if (process.env.ALLOW_UNVERSIONED_EMBEDDING_PUBLICATION !== 'true') throw new Error('Immutable embedding deployment revision required for publication');
      // Hosted dense-only APIs may not expose weight revisions. Permit fresh
      // per-version outputs explicitly, retaining immutable vector snapshots;
      // reusableEmbeddingIdentity stays false, so neither persistent nor memory
      // cross-request vector reuse is enabled and no known revision is invented.
      this.logger.warn('Publishing fresh version vectors with an unversioned hosted provider; cross-version embedding reuse remains disabled');
    }
    const fingerprint = embeddingFingerprint(config);
    let cursor = -1;
    for (;;) {
      const rows: any[] = await withServiceContext(this.prisma, tx => tx.$queryRaw`
        SELECT id,ord,content FROM "BlockArtifact"
        WHERE "versionId"=${versionId}::uuid AND ord>${cursor}
          AND (embedding IS NULL OR embedding_fingerprint IS DISTINCT FROM ${fingerprint})
        ORDER BY ord LIMIT ${this.readBatchSize}
      `);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].ord;
      await this.embedAndStore(rows, 'BlockArtifact');
    }
    const current = await this.embeddingService.getConfig();
    if (!current || embeddingFingerprint(current) !== fingerprint) throw new Error('Embedding model changed during generation');
    const rows: any[] = await withServiceContext(this.prisma, tx => tx.$queryRaw`
      SELECT count(*) FILTER (WHERE embedding IS NULL OR embedding_fingerprint IS DISTINCT FROM ${fingerprint})::int AS missing
      FROM "BlockArtifact" WHERE "versionId"=${versionId}::uuid
    `);
    return { fingerprint, missing: Number(rows[0]?.missing || 0) };
  }

  async coverage(): Promise<{ total: number; embedded: number }> {
    const rows: any = await withServiceContext(this.prisma, (tx) =>
      tx.$queryRaw<Array<{ total: bigint; embedded: bigint }>>`
      SELECT COUNT(*)::bigint AS total, COUNT(embedding)::bigint AS embedded FROM "Chunk"
    `);
    const row = rows[0];
    return { total: Number(row?.total || 0), embedded: Number(row?.embedded || 0) };
  }

  /**
   * Record which embedding space the stored vectors belong to.
   *
   * The query path compares stored vectors against a freshly embedded query
   * vector; if the model behind them changed they live in different spaces and
   * the cosine similarity is meaningless (no error, just silently wrong recall).
   * Persisting the model name + dimension per knowledge base makes that state
   * observable and lets the vector arm refuse to mix spaces.
   */
  async recordEmbeddingModelState(kbIds: Array<string | null | undefined>): Promise<void> {
    const unique = Array.from(new Set((kbIds || []).filter((id): id is string => Boolean(id))));
    if (!unique.length) return;
    try {
      const config = await this.embeddingService.getConfig();
      if (!config) return;
      const dimension = config.dimensions ?? null;
      await withServiceContext(this.prisma, (tx) =>
        (tx as any).$executeRaw`
        INSERT INTO "EmbeddingModelState" ("kbId", "modelName", "dimension", "updatedAt", "chunksAtWrite")
        SELECT k."kbId",
               ${config.modelName},
               ${dimension},
               CURRENT_TIMESTAMP,
               (SELECT count(*)::int FROM "Chunk" c WHERE c."kbId" = k."kbId" AND c.embedding IS NOT NULL)
        FROM unnest(${unique}::uuid[]) AS k("kbId")
        ON CONFLICT ("kbId") DO UPDATE
          SET "modelName" = EXCLUDED."modelName",
              "dimension" = EXCLUDED."dimension",
              "updatedAt" = CURRENT_TIMESTAMP,
              "chunksAtWrite" = EXCLUDED."chunksAtWrite"
      `);
    } catch (err) {
      // Fail-open: the marker is an integrity signal, not a correctness gate.
      this.logger.debug(
        `Embedding model state write skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
