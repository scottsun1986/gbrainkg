/**
 * Storage primitives for the PostgreSQL full-corpus BM25 channel.
 *
 * Kept free of Nest dependencies so the ingestion pipeline, the request path
 * and the backfill CLI all execute byte-identical SQL.
 *
 * Index layout
 * ------------
 *   ChunkLexicalDoc  one row per chunk: length + token tsvector (GIN indexed)
 *   LexicalTermStat  corpus document frequency per (kbId, term), maintained
 *                    incrementally as documents are (re)indexed
 *   KbLexicalStat    per-KB chunk count and total length (N and avgdl)
 *
 * Query shape
 * -----------
 *  1. Non-discriminative terms (df/N above a ratio threshold) are dropped
 *     unless they are all the query has — an IDF rule, not a stopword list,
 *     so it stays corpus-agnostic.
 *  2. PostgreSQL resolves the matching set for the whole ACL scope through the
 *     tsvector GIN index and orders it by `ts_rank_cd`, an engine-side
 *     relevance function. Only that relevance-ordered window is re-scored, so
 *     a LIMIT can never discard relevant chunks in favour of alphabetically
 *     early ones (the failure mode of `ORDER BY documentId, ord LIMIT n`).
 *  3. Okapi BM25 is then computed in SQL with the exact corpus df (from
 *     LexicalTermStat) and exact N / avgdl (from KbLexicalStat).
 */
import { lexicalLength, tokenize } from './lexical-tokenizer';
import { indexableChunkText } from '../ingestion/chunk-text';
import { withServiceContext } from '../db/tenant-context.service';

export interface LexicalPrismaLike {
  $queryRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  $executeRawUnsafe: (query: string, ...values: any[]) => Promise<any>;
  $transaction: (arg: any, opts?: any) => Promise<any>;
  [key: string]: any;
}

export interface LexicalHit {
  id: string;
  documentId: string;
  kbId: string;
  ord: number;
  content: string;
  metadata: any;
  document: { title: string; version: number };
  score: number;
}

export interface LexicalSearchStats {
  candidates: number;
  scored: number;
  window: number;
  termsKept: number;
  termsDropped: number;
  elapsedMs: number;
}

export const LEXICAL_WRITE_BATCH = Number(process.env.LEXICAL_INDEX_BATCH || 2000);

/**
 * Bumped whenever the statistics layout changes. A KB whose stored version is
 * behind is rebuilt once from its postings before the next incremental update,
 * which keeps installs that indexed before a layout change self-healing.
 */
/** v3 changed the stored lexeme layout to the prefixed `t<term>` form. */
export const LEXICAL_STATS_VERSION = 3;

/**
 * Every indexed lexeme is written as `t<term>`.
 *
 * PostgreSQL's text search parser re-tokenises whatever string it is given, and
 * it does not always agree with the application tokenizer: it splits "4e8c"
 * into "4e8" + "c" (scientific-notation rule) and "x_y" into "x" + "y". A
 * letter prefix makes every term start with a letter, after which the parser
 * keeps the whole alphanumeric run intact, so the index and the query are
 * guaranteed to speak the same term space instead of relying on parser luck.
 */
export const TERM_PREFIX = 't';

export function toIndexTerm(term: string): string {
  return `${TERM_PREFIX}${term}`;
}

export function fromIndexTerm(lexeme: string): string {
  return lexeme.startsWith(TERM_PREFIX) ? lexeme.slice(TERM_PREFIX.length) : lexeme;
}

/**
 * Tokenize one chunk exactly the way a query will be tokenized.
 *
 * The chunker's structural bookkeeping comments are projected out first (see
 * indexableChunkText): they were tokenized into every chunk, which added a
 * near-universal term to the corpus, inflated document length and therefore
 * skewed BM25's length normalisation.
 */
export function buildChunkTerms(content: string): { len: number; terms: string; unique: string[] } {
  const indexable = indexableChunkText(content);
  const tokens = tokenize(indexable);
  return {
    len: lexicalLength(indexable),
    terms: tokens.map(toIndexTerm).join(' '),
    unique: tokens,
  };
}

function chunkBatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Guarantee that the term statistics of a KB are usable for incremental
 * updates. Cheap on the steady-state path (one primary-key lookup); performs a
 * one-off rebuild from the postings when the stored layout is stale.
 */
export async function ensureKbStats(
  prisma: LexicalPrismaLike,
  kbId: string,
  options: { force?: boolean } = {},
): Promise<{ rebuilt: boolean; terms: number }> {
  return withServiceContext(prisma, (tx) =>
    ensureKbStatsInTx(tx as any, kbId, options),
  );
}

/** Same as ensureKbStats but reuses the caller's transaction client. */
export async function ensureKbStatsInTx(
  prisma: LexicalPrismaLike,
  kbId: string,
  options: { force?: boolean } = {},
): Promise<{ rebuilt: boolean; terms: number }> {
  const rows: any[] = await prisma.$queryRaw`
    SELECT COALESCE(MAX("statsVersion"), 0)::int AS version FROM "KbLexicalStat" WHERE "kbId" = ${kbId}::uuid
  `;
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!options.force && Number(row?.version || 0) >= LEXICAL_STATS_VERSION) {
    return { rebuilt: false, terms: 0 };
  }
  const terms = await rebuildKbTermStats(prisma, kbId);
  await prisma.$executeRaw`
    INSERT INTO "KbLexicalStat" ("kbId", "docCount", "totalLen", "statsVersion", "updatedAt")
    VALUES (
      ${kbId}::uuid,
      (SELECT count(*)::int FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
      (SELECT COALESCE(sum("len"), 0)::bigint FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
      ${LEXICAL_STATS_VERSION}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("kbId") DO UPDATE
      SET "docCount" = EXCLUDED."docCount", "totalLen" = EXCLUDED."totalLen",
          "statsVersion" = ${LEXICAL_STATS_VERSION}, "updatedAt" = CURRENT_TIMESTAMP
  `;
  return { rebuilt: true, terms };
}

/**
 * Replace the lexical postings of one document and update the corpus
 * statistics by the exact delta.
 *
 * Idempotent: enrichment retries and re-ingestion may call it any number of
 * times, and a document that is re-indexed with identical content leaves the
 * statistics unchanged.
 */
export async function indexDocumentChunks(
  prisma: LexicalPrismaLike,
  kbId: string,
  documentId: string,
  rows: Array<{ id: string; content: string }>,
  batchSize = LEXICAL_WRITE_BATCH,
): Promise<{ indexed: number; terms: number }> {
  // One interactive transaction for the whole document: previously every SQL
  // statement opened its own withServiceContext transaction (5-8 per doc),
  // which dominated ingest throughput at 25k docs.
  return withServiceContext(prisma, (tx) =>
    indexDocumentChunksInTx(tx as any, kbId, documentId, rows, batchSize),
  );
}

async function indexDocumentChunksInTx(
  prisma: LexicalPrismaLike,
  kbId: string,
  documentId: string,
  rows: Array<{ id: string; content: string }>,
  batchSize = LEXICAL_WRITE_BATCH,
): Promise<{ indexed: number; terms: number }> {
  if (!rows?.length) return { indexed: 0, terms: 0 };

  const built = rows.map((row) => ({ id: row.id, ...buildChunkTerms(String(row.content || '')) }));

  // Previous contribution of this document: per-term chunk counts plus the
  // corpus totals, read before the replacement so the delta is exact.
  const previousTerms: any[] = await prisma.$queryRaw`
    SELECT u.lexeme AS term, count(*)::int AS df
    FROM "ChunkLexicalDoc" l
    CROSS JOIN LATERAL unnest(l."tsv") AS u(lexeme, positions, weights)
    WHERE l."documentId" = ${documentId}::uuid
    GROUP BY u.lexeme
  `;
  const previousTotalsRows: any[] = await prisma.$queryRaw`
    SELECT count(*)::int AS docs, COALESCE(sum("len"), 0)::bigint AS total
    FROM "ChunkLexicalDoc" WHERE "documentId" = ${documentId}::uuid
  `;
  const previousTotals = (Array.isArray(previousTotalsRows) ? previousTotalsRows[0] : previousTotalsRows) || {
    docs: 0,
    total: 0,
  };

  const nextTermCounts = new Map<string, number>();
  for (const row of built) {
    for (const term of new Set(row.unique)) {
      nextTermCounts.set(term, (nextTermCounts.get(term) || 0) + 1);
    }
  }
  const previousTermCounts = new Map<string, number>();
  for (const row of previousTerms || []) {
    // Stored lexemes carry the index prefix; statistics are keyed by the plain
    // term, so both sides of the delta must speak the same vocabulary.
    const term = fromIndexTerm(String(row.term));
    previousTermCounts.set(term, (previousTermCounts.get(term) || 0) + Number(row.df || 0));
  }

  // Statistics written by an older layout (or never written at all) cannot be
  // trusted for an incremental delta: rebuild them from the postings that are
  // still in place, then apply the delta for this document below.
  await ensureKbStatsInTx(prisma, kbId);

  for (const batch of chunkBatches(built, batchSize)) {
    await prisma.$executeRaw`
      INSERT INTO "ChunkLexicalDoc" ("chunkId", "kbId", "documentId", "len", "tsv", "updatedAt")
      SELECT t.chunk_id, ${kbId}::uuid, ${documentId}::uuid, t.len, to_tsvector('simple', t.terms), CURRENT_TIMESTAMP
      FROM unnest(${batch.map((b) => b.id)}::uuid[], ${batch.map((b) => b.len)}::int4[], ${batch.map((b) => b.terms)}::text[])
        AS t(chunk_id, len, terms)
      ON CONFLICT ("chunkId") DO UPDATE
        SET "len" = EXCLUDED."len", "tsv" = EXCLUDED."tsv", "kbId" = EXCLUDED."kbId",
            "documentId" = EXCLUDED."documentId", "updatedAt" = CURRENT_TIMESTAMP
    `;
  }
  // Drop postings whose chunk disappeared in this document version. Scoped to
  // this document's own chunks so the planner uses the (documentId) index
  // instead of probing the whole Chunk table per row.
  await prisma.$executeRaw`
    DELETE FROM "ChunkLexicalDoc" l
    WHERE l."documentId" = ${documentId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM "Chunk" c
        WHERE c.id = l."chunkId" AND c."documentId" = ${documentId}::uuid
      )
  `;

  // Term frequency deltas.
  const deltaTerms: string[] = [];
  const deltaValues: number[] = [];
  for (const term of new Set([...nextTermCounts.keys(), ...previousTermCounts.keys()])) {
    const delta = (nextTermCounts.get(term) || 0) - (previousTermCounts.get(term) || 0);
    if (!delta) continue;
    deltaTerms.push(term);
    deltaValues.push(delta);
  }
  for (const batch of chunkBatches(
    deltaTerms.map((term, i) => ({ term, delta: deltaValues[i] })),
    batchSize,
  )) {
    await prisma.$executeRaw`
      INSERT INTO "LexicalTermStat" ("kbId", "term", "df", "updatedAt")
      SELECT ${kbId}::uuid, t.term, t.delta, CURRENT_TIMESTAMP
      FROM unnest(${batch.map((b) => b.term)}::text[], ${batch.map((b) => b.delta)}::int4[]) AS t(term, delta)
      WHERE t.delta > 0
      ON CONFLICT ("kbId", "term") DO UPDATE
        SET "df" = GREATEST("LexicalTermStat"."df" + EXCLUDED."df", 0), "updatedAt" = CURRENT_TIMESTAMP
    `;
    const decreases = batch.filter((b) => b.delta < 0);
    if (decreases.length) {
      await prisma.$executeRaw`
        UPDATE "LexicalTermStat" SET "df" = GREATEST("df" + d.delta, 0), "updatedAt" = CURRENT_TIMESTAMP
        FROM unnest(${decreases.map((b) => b.term)}::text[], ${decreases.map((b) => b.delta)}::int4[]) AS d(term, delta)
        WHERE "LexicalTermStat"."kbId" = ${kbId}::uuid AND "LexicalTermStat"."term" = d.term
      `;
      await prisma.$executeRaw`
        DELETE FROM "LexicalTermStat"
        WHERE "kbId" = ${kbId}::uuid AND "df" <= 0 AND "term" = ANY(${decreases.map((b) => b.term)}::text[])
      `;
    }
  }

  const docDelta = built.length - Number(previousTotals.docs || 0);
  const lenDelta = built.reduce((sum, row) => sum + row.len, 0) - Number(previousTotals.total || 0);
  await prisma.$executeRaw`
    INSERT INTO "KbLexicalStat" ("kbId", "docCount", "totalLen", "updatedAt")
    SELECT ${kbId}::uuid,
           (SELECT count(*)::int FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
           (SELECT COALESCE(sum("len"), 0)::bigint FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
           CURRENT_TIMESTAMP
    ON CONFLICT ("kbId") DO UPDATE
      SET "docCount" = GREATEST("KbLexicalStat"."docCount" + ${docDelta}, 0),
          "totalLen" = GREATEST("KbLexicalStat"."totalLen" + ${lenDelta}, 0),
          "updatedAt" = CURRENT_TIMESTAMP
  `;
  return { indexed: built.length, terms: nextTermCounts.size };
}

/** Recompute the per-KB corpus statistics from the postings (repair path). */

/**
 * Bulk-index many documents in ONE transaction. Used by backfill / scale-seed /
 * connector sync where per-document transaction overhead dominates.
 * Term statistics are aggregated per KB before applying deltas.
 */
export async function bulkIndexDocumentChunks(
  prisma: LexicalPrismaLike,
  docs: Array<{ kbId: string; documentId: string; rows: Array<{ id: string; content: string }> }>,
  batchSize = LEXICAL_WRITE_BATCH,
): Promise<{ indexed: number; terms: number; documents: number }> {
  const active = docs.filter((d) => d.rows?.length);
  if (!active.length) return { indexed: 0, terms: 0, documents: 0 };
  return withServiceContext(prisma, async (tx) => {
    const client = tx as any;
    let indexed = 0;
    // Aggregate df deltas per KB across all documents in the batch.
    const kbNext = new Map<string, Map<string, number>>();
    const kbPrev = new Map<string, Map<string, number>>();
    const kbPrevDocs = new Map<string, number>();
    const kbPrevLen = new Map<string, number>();

    for (const doc of active) {
      const built = doc.rows.map((row) => ({
        id: row.id,
        ...buildChunkTerms(String(row.content || '')),
      }));
      indexed += built.length;

      const previousTerms: any[] = await client.$queryRaw`
        SELECT u.lexeme AS term, count(*)::int AS df
        FROM "ChunkLexicalDoc" l
        CROSS JOIN LATERAL unnest(l."tsv") AS u(lexeme, positions, weights)
        WHERE l."documentId" = ${doc.documentId}::uuid
        GROUP BY u.lexeme
      `;
      const previousTotalsRows: any[] = await client.$queryRaw`
        SELECT count(*)::int AS docs, COALESCE(sum("len"), 0)::bigint AS total
        FROM "ChunkLexicalDoc" WHERE "documentId" = ${doc.documentId}::uuid
      `;
      const previousTotals = (Array.isArray(previousTotalsRows) ? previousTotalsRows[0] : previousTotalsRows) || {
        docs: 0,
        total: 0,
      };

      const nextMap = kbNext.get(doc.kbId) || new Map<string, number>();
      for (const row of built) {
        for (const term of new Set(row.unique)) {
          nextMap.set(term, (nextMap.get(term) || 0) + 1);
        }
      }
      kbNext.set(doc.kbId, nextMap);

      const prevMap = kbPrev.get(doc.kbId) || new Map<string, number>();
      for (const row of previousTerms || []) {
        const term = fromIndexTerm(String(row.term));
        prevMap.set(term, (prevMap.get(term) || 0) + Number(row.df || 0));
      }
      kbPrev.set(doc.kbId, prevMap);
      kbPrevDocs.set(doc.kbId, (kbPrevDocs.get(doc.kbId) || 0) + Number(previousTotals.docs || 0));
      kbPrevLen.set(doc.kbId, (kbPrevLen.get(doc.kbId) || 0) + Number(previousTotals.total || 0));

      for (const batch of chunkBatches(built, batchSize)) {
        await client.$executeRaw`
          INSERT INTO "ChunkLexicalDoc" ("chunkId", "kbId", "documentId", "len", "tsv", "updatedAt")
          SELECT t.chunk_id, ${doc.kbId}::uuid, ${doc.documentId}::uuid, t.len, to_tsvector('simple', t.terms), CURRENT_TIMESTAMP
          FROM unnest(${batch.map((b) => b.id)}::uuid[], ${batch.map((b) => b.len)}::int4[], ${batch.map((b) => b.terms)}::text[])
            AS t(chunk_id, len, terms)
          ON CONFLICT ("chunkId") DO UPDATE
            SET "len" = EXCLUDED."len", "tsv" = EXCLUDED."tsv", "kbId" = EXCLUDED."kbId",
                "documentId" = EXCLUDED."documentId", "updatedAt" = CURRENT_TIMESTAMP
        `;
      }
      await client.$executeRaw`
        DELETE FROM "ChunkLexicalDoc" l
        WHERE l."documentId" = ${doc.documentId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM "Chunk" c
            WHERE c.id = l."chunkId" AND c."documentId" = ${doc.documentId}::uuid
          )
      `;
    }

    let totalTerms = 0;
    for (const [kbId, nextMap] of kbNext) {
      const prevMap = kbPrev.get(kbId) || new Map<string, number>();
      totalTerms += nextMap.size;
      const deltaTerms: Array<{ term: string; delta: number }> = [];
      for (const term of new Set([...nextMap.keys(), ...prevMap.keys()])) {
        const delta = (nextMap.get(term) || 0) - (prevMap.get(term) || 0);
        if (delta) deltaTerms.push({ term, delta });
      }
      for (const batch of chunkBatches(deltaTerms, batchSize)) {
        await client.$executeRaw`
          INSERT INTO "LexicalTermStat" ("kbId", "term", "df", "updatedAt")
          SELECT ${kbId}::uuid, t.term, t.delta, CURRENT_TIMESTAMP
          FROM unnest(${batch.map((b) => b.term)}::text[], ${batch.map((b) => b.delta)}::int4[]) AS t(term, delta)
          WHERE t.delta > 0
          ON CONFLICT ("kbId", "term") DO UPDATE
            SET "df" = GREATEST("LexicalTermStat"."df" + EXCLUDED."df", 0), "updatedAt" = CURRENT_TIMESTAMP
        `;
        const decreases = batch.filter((b) => b.delta < 0);
        if (decreases.length) {
          await client.$executeRaw`
            UPDATE "LexicalTermStat" SET "df" = GREATEST("df" + d.delta, 0), "updatedAt" = CURRENT_TIMESTAMP
            FROM unnest(${decreases.map((b) => b.term)}::text[], ${decreases.map((b) => b.delta)}::int4[]) AS d(term, delta)
            WHERE "LexicalTermStat"."kbId" = ${kbId}::uuid AND "LexicalTermStat"."term" = d.term
          `;
          await client.$executeRaw`
            DELETE FROM "LexicalTermStat"
            WHERE "kbId" = ${kbId}::uuid AND "df" <= 0 AND "term" = ANY(${decreases.map((b) => b.term)}::text[])
          `;
        }
      }
      const docCount = active.filter((d) => d.kbId === kbId).length;
      const docDelta = docCount - (kbPrevDocs.get(kbId) || 0);
      const builtLen = active
        .filter((d) => d.kbId === kbId)
        .flatMap((d) => d.rows.map((r) => lexicalLength(indexableChunkText(String(r.content || '')))))
        .reduce((a, b) => a + b, 0);
      const lenDelta = builtLen - (kbPrevLen.get(kbId) || 0);
      await client.$executeRaw`
        INSERT INTO "KbLexicalStat" ("kbId", "docCount", "totalLen", "updatedAt")
        SELECT ${kbId}::uuid,
               (SELECT count(*)::int FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
               (SELECT COALESCE(sum("len"), 0)::bigint FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
               CURRENT_TIMESTAMP
        ON CONFLICT ("kbId") DO UPDATE
          SET "docCount" = GREATEST("KbLexicalStat"."docCount" + ${docDelta}, 0),
              "totalLen" = GREATEST("KbLexicalStat"."totalLen" + ${lenDelta}, 0),
              "updatedAt" = CURRENT_TIMESTAMP
      `;
    }
    return { indexed, terms: totalTerms, documents: active.length };
  });
}

export async function refreshKbStat(prisma: LexicalPrismaLike, kbId: string): Promise<void> {
  await withServiceContext(prisma, (tx) => tx.$executeRaw`
    INSERT INTO "KbLexicalStat" ("kbId", "docCount", "totalLen", "updatedAt")
    SELECT ${kbId}::uuid, count(*)::int, COALESCE(sum("len"), 0)::bigint, CURRENT_TIMESTAMP
    FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid
    ON CONFLICT ("kbId") DO UPDATE
      SET "docCount" = EXCLUDED."docCount", "totalLen" = EXCLUDED."totalLen",
          "updatedAt" = CURRENT_TIMESTAMP
  `);
}

/**
 * Remove one document's postings and repair the corpus statistics.
 *
 * Deleting a Document cascades to Chunk and then to ChunkLexicalDoc (both FKs are
 * ON DELETE CASCADE), so the postings disappear by themselves — but
 * `LexicalTermStat.df` and `KbLexicalStat` (N / avgdl) are maintained
 * incrementally and would keep the deleted document's contribution forever.
 * BM25 would then score every remaining query against a corpus that no longer
 * exists, drifting further with every deletion until someone ran a manual
 * rebuild.
 *
 * Must be called BEFORE the document row is deleted. Idempotent: the delta is
 * derived from the postings that are still present.
 */
export async function unindexDocument(
  prisma: LexicalPrismaLike,
  kbId: string,
  documentId: string,
  batchSize = LEXICAL_WRITE_BATCH,
): Promise<{ removed: number; terms: number }> {
  const termRows: any[] = await withServiceContext(prisma, (tx) => tx.$queryRaw`
    SELECT u.lexeme AS lexeme, count(*)::int AS df
    FROM "ChunkLexicalDoc" l
    CROSS JOIN LATERAL unnest(l."tsv") AS u(lexeme, positions, weights)
    WHERE l."documentId" = ${documentId}::uuid
    GROUP BY u.lexeme
  `);
  if (!termRows.length) {
    // Nothing indexed for this document: still refresh the KB totals so a
    // previously drifted row self-heals.
    await refreshKbStat(prisma, kbId);
    return { removed: 0, terms: 0 };
  }

  const termDeltas = termRows.map((row) => ({
    term: fromIndexTerm(String(row.lexeme)),
    delta: -Number(row.df || 0),
  }));

  const removedRows: any[] = await withServiceContext(prisma, (tx) => tx.$queryRaw`
    SELECT count(*)::int AS docs, COALESCE(sum("len"), 0)::bigint AS total
    FROM "ChunkLexicalDoc" WHERE "documentId" = ${documentId}::uuid
  `);
  const removed = Array.isArray(removedRows) ? removedRows[0] : removedRows;

  const deleted = await withServiceContext(prisma, (tx) => tx.$executeRaw`
    DELETE FROM "ChunkLexicalDoc" WHERE "documentId" = ${documentId}::uuid
  `);

  for (const batch of chunkBatches(termDeltas, batchSize)) {
    await withServiceContext(prisma, (tx) => tx.$executeRaw`
      UPDATE "LexicalTermStat" SET "df" = GREATEST("df" + d.delta, 0), "updatedAt" = CURRENT_TIMESTAMP
      FROM unnest(${batch.map((b) => b.term)}::text[], ${batch.map((b) => b.delta)}::int4[]) AS d(term, delta)
      WHERE "LexicalTermStat"."kbId" = ${kbId}::uuid AND "LexicalTermStat"."term" = d.term
    `);
    await withServiceContext(prisma, (tx) => tx.$executeRaw`
      DELETE FROM "LexicalTermStat"
      WHERE "kbId" = ${kbId}::uuid AND "df" <= 0 AND "term" = ANY(${batch.map((b) => b.term)}::text[])
    `);
  }

  // Recompute N / avgdl from the surviving postings instead of subtracting a
  // computed delta: the authoritative count is one cheap aggregate and removes
  // any chance of a silently negative or stale statistic.
  await withServiceContext(prisma, (tx) => tx.$executeRaw`
    INSERT INTO "KbLexicalStat" ("kbId", "docCount", "totalLen", "updatedAt")
    SELECT ${kbId}::uuid,
           (SELECT count(*)::int FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
           (SELECT COALESCE(sum("len"), 0)::bigint FROM "ChunkLexicalDoc" WHERE "kbId" = ${kbId}::uuid),
           CURRENT_TIMESTAMP
    ON CONFLICT ("kbId") DO UPDATE
      SET "docCount" = EXCLUDED."docCount", "totalLen" = EXCLUDED."totalLen",
          "updatedAt" = CURRENT_TIMESTAMP
  `);

  return {
    removed: Number(deleted || removed?.docs || 0),
    terms: termDeltas.length,
  };
}

/** Rebuild LexicalTermStat for one KB from the postings (repair path). */
export async function rebuildKbTermStats(prisma: LexicalPrismaLike, kbId: string): Promise<number> {
  await prisma.$executeRaw`DELETE FROM "LexicalTermStat" WHERE "kbId" = ${kbId}::uuid`;
  await prisma.$executeRaw`
    INSERT INTO "LexicalTermStat" ("kbId", "term", "df", "updatedAt")
    SELECT l."kbId", stripped.term, count(*)::int, CURRENT_TIMESTAMP
    FROM "ChunkLexicalDoc" l
    CROSS JOIN LATERAL unnest(l."tsv") AS u(lexeme, positions, weights)
    CROSS JOIN LATERAL (SELECT substr(u.lexeme, ${TERM_PREFIX.length + 1}::int) AS term) AS stripped
    WHERE l."kbId" = ${kbId}::uuid
    GROUP BY l."kbId", stripped.term
  `;
  const rows: any[] = await prisma.$queryRaw`
    SELECT count(*)::int AS terms FROM "LexicalTermStat" WHERE "kbId" = ${kbId}::uuid
  `;
  const row = Array.isArray(rows) ? rows[0] : rows;
  return Number(row?.terms || 0);
}

/** Number of indexed chunks versus stored chunks for a retrieval scope. */
export async function lexicalCoverage(
  prisma: LexicalPrismaLike,
  scope: string[],
): Promise<{ indexed: number; chunks: number }> {
  if (!scope.length) return { indexed: 0, chunks: 0 };
  const rows = await withServiceContext(prisma, (tx) => tx.$queryRaw`
    SELECT
      (SELECT count(*)::int FROM "ChunkLexicalDoc" WHERE "kbId" = ANY(${scope}::uuid[])) AS indexed,
      (SELECT count(*)::int FROM "Chunk" WHERE "kbId" = ANY(${scope}::uuid[])) AS chunks
  `);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { indexed: Number(row?.indexed || 0), chunks: Number(row?.chunks || 0) };
}

/** Health report used by the scale benchmark and the SOTA gate. */
export async function lexicalIndexHealth(prisma: LexicalPrismaLike): Promise<{
  chunks: number;
  indexed: number;
  terms: number;
  kbStatRows: number;
}> {
  const rows: any[] = await withServiceContext(prisma, (tx) => tx.$queryRaw`
    SELECT
      (SELECT count(*)::int FROM "Chunk") AS chunks,
      (SELECT count(*)::int FROM "ChunkLexicalDoc") AS indexed,
      (SELECT count(*)::int FROM "LexicalTermStat") AS terms,
      (SELECT count(*)::int FROM "KbLexicalStat") AS "kbStatRows"
  `);
  const row = (Array.isArray(rows) ? rows[0] : rows) || {};
  return {
    chunks: Number(row.chunks || 0),
    indexed: Number(row.indexed || 0),
    terms: Number(row.terms || 0),
    kbStatRows: Number(row.kbStatRows || 0),
  };
}

export interface LexicalSearchOptions {
  k1?: number;
  b?: number;
  timeoutMs?: number;
  /** Relevance-ordered candidate window; 0 disables the window (exact scan). */
  window?: number;
  /** Terms with df/N above this ratio are dropped unless nothing else remains. */
  maxDfRatio?: number;
  /**
   * Upper bound on the number of matching chunks the engine is asked to rank
   * in one pass. Terms are taken rarest-first until their summed df reaches it,
   * which keeps the engine-side ranking cost bounded as the corpus grows.
   */
  candidateBudget?: number;
  /** Always keep at least this many terms, however common they are. */
  minTerms?: number;
  /**
   * Skip the engine channel when even the rarest query term occurs in more
   * than this share of the corpus: such a query has no lexical discrimination
   * to offer, and forcing the ranker to walk the whole collection costs
   * hundreds of milliseconds for a candidate list the other arms already
   * cover. The caller falls back to the legacy candidate pool in that case.
   */
  maxRarestDfRatio?: number;
}

/**
 * Full-corpus BM25 ranking. `terms` must come from `tokenizeQuery` so index and
 * query share one term space.
 */
export async function searchLexicalBm25(
  prisma: LexicalPrismaLike,
  scope: string[],
  terms: string[],
  limit: number,
  options: LexicalSearchOptions = {},
): Promise<LexicalHit[]> {
  const { hits } = await searchLexicalBm25Detailed(prisma, scope, terms, limit, options);
  return hits;
}

export async function searchLexicalBm25Detailed(
  prisma: LexicalPrismaLike,
  scope: string[],
  terms: string[],
  limit: number,
  options: LexicalSearchOptions = {},
): Promise<{ hits: LexicalHit[]; stats: LexicalSearchStats }> {
  const emptyStats: LexicalSearchStats = {
    candidates: 0,
    scored: 0,
    window: 0,
    termsKept: 0,
    termsDropped: 0,
    elapsedMs: 0,
  };
  if (!scope.length) return { hits: [], stats: emptyStats };
  const uniqueTerms = Array.from(new Set(terms.filter((t) => t && t.length <= 128))).slice(0, 128);
  if (!uniqueTerms.length) return { hits: [], stats: emptyStats };

  const k1 = Number(options.k1 ?? process.env.LEXICAL_BM25_K1 ?? 1.2);
  const b = Number(options.b ?? process.env.LEXICAL_BM25_B ?? 0.75);
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? process.env.LEXICAL_STATEMENT_TIMEOUT_MS ?? 2500));
  const window = Math.max(
    0,
    Math.floor(Number(options.window ?? process.env.LEXICAL_CANDIDATE_WINDOW ?? 2000)),
  );
  const maxDfRatio = Number(options.maxDfRatio ?? process.env.LEXICAL_MAX_DF_RATIO ?? 0.5);
  const candidateBudget = Math.max(
    100,
    Number(options.candidateBudget ?? process.env.LEXICAL_CANDIDATE_BUDGET ?? 8000),
  );
  const minTerms = Math.max(1, Number(options.minTerms ?? process.env.LEXICAL_MIN_TERMS ?? 1));
  const maxRarestDfRatio = Number(
    options.maxRarestDfRatio ?? process.env.LEXICAL_MAX_RAREST_DF_RATIO ?? 0.3,
  );
  const take = Math.max(1, Math.min(5000, Math.floor(limit)));
  const started = Date.now();

  // No interactive transaction here on purpose: the production box has a small
  // Prisma pool and a background enrichment queue, and holding a transaction
  // per retrieval arm produced "Unable to start a transaction in the given
  // time" under load. The query is bounded by the candidate budget, so the
  // timeout is applied by the caller (RetrievalDeadline) instead.
  void timeoutMs;
  const rows = await withServiceContext(prisma, (tx) => tx.$queryRaw`
      WITH qterms AS (
        SELECT DISTINCT unnest(${uniqueTerms}::text[]) AS term
      ),
      scope_terms AS (
        SELECT q.term, COALESCE(sum(s."df"), 0)::float8 AS df
        FROM qterms q
        LEFT JOIN "LexicalTermStat" s
          ON s."term" = q.term AND s."kbId" = ANY(${scope}::uuid[])
        GROUP BY q.term
      ),
      totals AS (
        SELECT GREATEST(COALESCE(sum("docCount"), 0), 1)::float8 AS n,
               GREATEST(
                 COALESCE(sum("totalLen"), 0)::float8 / GREATEST(COALESCE(sum("docCount"), 0), 1),
                 1
               )::float8 AS avgdl
        FROM "KbLexicalStat" WHERE "kbId" = ANY(${scope}::uuid[])
      ),
      discriminative AS (
        SELECT t.term, t.df FROM scope_terms t, totals
        -- df = 0 means the term does not occur in the corpus at all; it can
        -- never match, so it must not consume a slot in the rarest-first
        -- budget below.
        WHERE t.df >= 1 AND t.df <= GREATEST(${maxDfRatio}::float8 * totals.n, 1)
      ),
      -- Rarest-first cumulative df: a cheap upper bound on how many chunks the
      -- engine has to rank. Without it a query made of common terms makes the
      -- ranker walk the whole corpus (measured: 2.2 s for 96k candidates on the
      -- 100k-chunk benchmark, versus ~0.2 s once the budget bounds it).
      budget_source AS (
        SELECT term, df FROM discriminative
        UNION ALL
        -- Every term is common (short/filler query): fall back to the full set.
        SELECT term, df FROM scope_terms WHERE NOT EXISTS (SELECT 1 FROM discriminative)
      ),
      budgeted AS (
        SELECT term, df,
               row_number() OVER (ORDER BY df ASC, term) AS rarity_rank,
               sum(df) OVER (ORDER BY df ASC, term) AS running_df
        FROM budget_source
      ),
      kept AS (
        SELECT term FROM budgeted
        WHERE running_df <= ${candidateBudget}::float8 OR rarity_rank <= ${minTerms}
      ),
      q AS (
        -- Prefix only when building the tsquery: df/IDF statistics stay keyed
        -- by the plain term, while the engine sees the same prefixed lexemes
        -- the index holds.
        SELECT lexical_tsquery(array_agg(${TERM_PREFIX} || term)) AS tsq
        FROM kept
        WHERE (SELECT COALESCE(min(df), 0) FROM discriminative)
              <= GREATEST(${maxRarestDfRatio}::float8 * (SELECT n FROM totals), 1)
      ),
      candidates AS (
        SELECT l."chunkId" AS chunk_id, l."len" AS len, l."tsv" AS tsv,
               ts_rank_cd(l."tsv", q.tsq) AS rank
        FROM "ChunkLexicalDoc" l
        JOIN "Document" d ON d.id = l."documentId"
        CROSS JOIN q
        WHERE q.tsq IS NOT NULL
          AND l."kbId" = ANY(${scope}::uuid[])
          AND d.status = 'published'
          AND l."tsv" @@ q.tsq
        ORDER BY rank DESC, l."chunkId"
        LIMIT ${window > 0 ? window : null}
      ),
      tf AS (
        SELECT c.chunk_id,
               substr(u.lexeme, ${TERM_PREFIX.length + 1}::int) AS term,
               array_length(u.positions, 1)::float8 AS tf
        FROM candidates c
        CROSS JOIN LATERAL unnest(c.tsv) AS u(lexeme, positions, weights)
        JOIN kept k ON k.term = substr(u.lexeme, ${TERM_PREFIX.length + 1}::int)
      ),
      scored AS (
        SELECT tf.chunk_id,
               sum(
                 ln(1 + (totals.n - GREATEST(scope_terms.df, 0) + 0.5) / (GREATEST(scope_terms.df, 0) + 0.5)) *
                 (tf.tf * (${k1}::float8 + 1)) /
                 (tf.tf + ${k1}::float8 * (1 - ${b}::float8 + ${b}::float8 * GREATEST(candidates.len, 1) / totals.avgdl))
               ) AS score
        FROM tf
        JOIN scope_terms ON scope_terms.term = tf.term
        JOIN candidates ON candidates.chunk_id = tf.chunk_id
        CROSS JOIN totals
        GROUP BY tf.chunk_id
      )
      SELECT s.score,
             c.id, c."documentId", c."kbId", c.ord, c.content, c.metadata,
             d.title AS "docTitle", d.version AS "docVersion",
             (SELECT count(*)::int FROM candidates) AS candidate_count,
             (SELECT count(*)::int FROM scored) AS scored_count,
             (SELECT count(*)::int FROM kept) AS kept_count,
             (SELECT count(*)::int FROM qterms) AS total_terms
      FROM scored s
      JOIN "Chunk" c ON c.id = s.chunk_id
      JOIN "Document" d ON d.id = c."documentId"
      WHERE d.status = 'published'
      ORDER BY s.score DESC
      LIMIT ${take}
    `);

  const list = Array.isArray(rows) ? rows : [rows];
  const hits = list
    .filter((row: any) => row && row.id)
    .map((row: any) => ({
      id: String(row.id),
      documentId: String(row.documentId),
      kbId: String(row.kbId),
      ord: Number(row.ord || 0),
      content: String(row.content || ''),
      metadata: row.metadata,
      document: { title: String(row.docTitle || ''), version: Number(row.docVersion || 1) },
      score: Number(row.score || 0),
    }))
    .filter((hit) => Number.isFinite(hit.score) && hit.score > 0);
  const first: any = list.find((row: any) => row && row.candidate_count !== undefined);
  return {
    hits,
    stats: {
      candidates: Number(first?.candidate_count || 0),
      scored: Number(first?.scored_count || 0),
      window,
      termsKept: Number(first?.kept_count || 0),
      termsDropped: Number((first?.total_terms || 0) - (first?.kept_count || 0)),
      elapsedMs: Date.now() - started,
    },
  };
}
