/**
 * Integration tests for the PostgreSQL full-corpus BM25 channel.
 *
 * They run against a real PostgreSQL+pgvector instance in a throwaway schema,
 * because the behaviour under test *is* the SQL: engine-side candidate
 * resolution, exact corpus IDF, the ACL/published gate and the truncation
 * regression that motivated the channel.
 *
 *   LEXICAL_INDEX_INTEGRATION=1 DATABASE_URL=postgresql://... \
 *     npx jest src/retrieval/lexical-index.integration.spec.ts
 *
 * The schema is named per test run and dropped afterwards; the test never
 * touches the application schema.
 */
import { PrismaClient } from '@prisma/client';
import {
  fromIndexTerm,
  indexDocumentChunks,
  lexicalCoverage,
  searchLexicalBm25Detailed,
  toIndexTerm,
} from './lexical-index-store';
import { tokenize, tokenizeQuery } from './lexical-tokenizer';

const RUN = process.env.LEXICAL_INDEX_INTEGRATION === '1';
const describeIntegration = RUN ? describe : describe.skip;
const SCHEMA = `lex_itest_${process.pid}_${Date.now().toString(36)}`;

const KB_A = '11111111-1111-4111-8111-111111111111';
const KB_B = '22222222-2222-4222-8222-222222222222';

function uuid(prefix: number, index: number): string {
  return `${String(prefix).repeat(8)}-${String(prefix).repeat(4)}-4${String(prefix).repeat(3)}-8${String(
    prefix,
  ).repeat(3)}-${index.toString(16).padStart(12, '0')}`;
}

describeIntegration('full-corpus BM25 channel (integration)', () => {
  let admin: PrismaClient;
  let prisma: PrismaClient;

  const statements = (schema: string): string[] => [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    `CREATE TABLE "${schema}"."Document" (
       id uuid PRIMARY KEY, "kbId" uuid NOT NULL, title text NOT NULL,
       status text NOT NULL DEFAULT 'published', version integer NOT NULL DEFAULT 1)`,
    `CREATE TABLE "${schema}"."Chunk" (
       id uuid PRIMARY KEY, "documentId" uuid NOT NULL, "kbId" uuid NOT NULL,
       ord integer NOT NULL, content text NOT NULL, metadata jsonb)`,
    `CREATE INDEX "${schema}_chunk_document_idx" ON "${schema}"."Chunk" ("documentId")`,
    `CREATE TABLE "${schema}"."ChunkLexicalDoc" (
       "chunkId" uuid PRIMARY KEY, "kbId" uuid NOT NULL, "documentId" uuid NOT NULL,
       "len" integer NOT NULL, tsv tsvector NOT NULL,
       "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX "${schema}_lexical_tsv_idx" ON "${schema}"."ChunkLexicalDoc" USING gin (tsv)`,
    `CREATE INDEX "${schema}_lexical_doc_idx" ON "${schema}"."ChunkLexicalDoc" ("documentId")`,
    `CREATE INDEX "${schema}_lexical_kbid_idx" ON "${schema}"."ChunkLexicalDoc" ("kbId", "len")`,
    `CREATE TABLE "${schema}"."LexicalTermStat" (
       "kbId" uuid NOT NULL, term text NOT NULL, df integer NOT NULL DEFAULT 0,
       "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("kbId", term))`,
    `CREATE INDEX "${schema}_lexical_term_idx" ON "${schema}"."LexicalTermStat" (term)`,
    `CREATE TABLE "${schema}"."KbLexicalStat" (
       "kbId" uuid PRIMARY KEY, "docCount" integer NOT NULL DEFAULT 0,
       "totalLen" bigint NOT NULL DEFAULT 0, "statsVersion" integer NOT NULL DEFAULT 0,
       "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE FUNCTION "${schema}".lexical_tsquery(terms text[]) RETURNS tsquery AS $$
       DECLARE joined text;
       BEGIN
         SELECT string_agg(quote_literal(t), ' | ') INTO joined FROM unnest(terms) AS t;
         IF joined IS NULL OR joined = '' THEN RETURN NULL; END IF;
         RETURN to_tsquery('simple', joined);
       END; $$ LANGUAGE plpgsql IMMUTABLE`,
  ];

  beforeAll(async () => {
    if (!RUN) return;
    const baseUrl = process.env.DATABASE_URL || '';
    if (!baseUrl) throw new Error('DATABASE_URL is required for the integration test.');
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    for (const statement of statements(SCHEMA)) {
      await admin.$executeRawUnsafe(statement);
    }
    const url = new URL(baseUrl);
    url.searchParams.set('schema', SCHEMA);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  }, 60_000);

  afterAll(async () => {
    if (!RUN) return;
    await prisma?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin?.$disconnect();
  }, 60_000);

  async function seedDocument(
    docIndex: number,
    kbId: string,
    status: string,
    contents: string[],
    prefix = 3,
  ): Promise<string[]> {
    const documentId = uuid(prefix + (docIndex % 3), docIndex);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Document" (id, "kbId", title, status) VALUES ($1::uuid, $2::uuid, $3, $4)`,
      documentId,
      kbId,
      `doc-${docIndex}`,
      status,
    );
    const chunkIds: string[] = [];
    const rows: Array<{ id: string; content: string }> = [];
    for (let i = 0; i < contents.length; i += 1) {
      const chunkId = uuid(4 + (docIndex % 3), docIndex * 100 + i);
      chunkIds.push(chunkId);
      rows.push({ id: chunkId, content: contents[i] });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Chunk" (id, "documentId", "kbId", ord, content) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
        chunkId,
        documentId,
        kbId,
        i,
        contents[i],
      );
    }
    await indexDocumentChunks(prisma as any, kbId, documentId, rows);
    return chunkIds;
  }

  it('ranks a rare-term chunk above boilerplate chunks', async () => {
    const common = Array.from({ length: 20 }, (_, i) => `第${i + 1}条 本制度适用于全体员工，报销标准另行规定。`);
    await seedDocument(1, KB_A, 'published', common);
    const [targetId] = await seedDocument(2, KB_A, 'published', [
      '第99条 碳中和专项补贴的申请材料包括碳排放核算报告与减排量核证文件。',
    ]);

    const { hits } = await searchLexicalBm25Detailed(
      prisma as any,
      [KB_A],
      tokenizeQuery('碳中和补贴申请材料 碳排放核算报告'),
      10,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe(targetId);
  }, 60_000);

  it('does not lose a relevant chunk that an ordered LIMIT would truncate', async () => {
    // 300 boilerplate chunks spread over many documents, all containing the
    // single high-frequency term "制度". The relevant chunk sits in the
    // document whose id sorts *last*, which is exactly where the previous
    // `ORDER BY documentId, ord LIMIT n` candidate sweep would have dropped it.
    const boilerplate = '制度 制度 本制度适用于全体员工。';
    for (let i = 0; i < 60; i += 1) {
      await seedDocument(100 + i, KB_B, 'published', [boilerplate, boilerplate, boilerplate, boilerplate, boilerplate]);
    }
    const [targetId] = await seedDocument(9999, KB_B, 'published', [
      '制度 稀土配额调剂办法规定：超配额部分按百分之三百计征调节费。',
    ]);

    const { hits, stats } = await searchLexicalBm25Detailed(
      prisma as any,
      [KB_B],
      tokenizeQuery('稀土配额调剂 超配额 调节费'),
      10,
    );
    expect(stats.candidates).toBeGreaterThanOrEqual(1);
    expect(hits.map((hit) => hit.id)).toContain(targetId);
  }, 120_000);

  it('enforces ACL scope and the published gate inside the same statement', async () => {
    const [foreignId] = await seedDocument(500, KB_B, 'published', [
      '涉密内容：量子加密密钥轮换周期为九十天。',
    ]);
    const [draftId] = await seedDocument(501, KB_A, 'indexing', [
      '草稿内容：量子加密密钥轮换周期为一百八十天。',
    ]);

    const { hits } = await searchLexicalBm25Detailed(
      prisma as any,
      [KB_A],
      tokenizeQuery('量子加密密钥轮换周期'),
      10,
    );
    const ids = hits.map((hit) => hit.id);
    expect(ids).not.toContain(foreignId); // outside the requested KB scope
    expect(ids).not.toContain(draftId); // inside scope but not published
  }, 60_000);

  it('keeps postings, term statistics and the tokenizer exactly in step', async () => {
    const mismatchFree = await prisma.$queryRaw<any[]>`
      WITH postings AS (
        SELECT l."chunkId", u.lexeme AS term
        FROM "ChunkLexicalDoc" l
        CROSS JOIN LATERAL unnest(l."tsv") AS u(lexeme, positions, weights)
      ),
      stat AS (SELECT sum(df)::int AS total FROM "LexicalTermStat")
      SELECT (SELECT count(*)::int FROM postings) AS postings,
             (SELECT total FROM stat) AS stat_df,
             (SELECT count(*)::int FROM "ChunkLexicalDoc") AS chunks
    `;
    const row = mismatchFree[0];
    expect(row.postings).toBe(row.stat_df);

    const chunks: Array<{ id: string; content: string }> = await prisma.$queryRaw`
      SELECT id, content FROM "Chunk"
    `;
    for (const chunk of chunks) {
      const expected = new Set(tokenize(chunk.content).map(toIndexTerm));
      const stored: any[] = await prisma.$queryRaw`
        SELECT array(SELECT u.lexeme FROM unnest(l."tsv") AS u(lexeme, positions, weights)) AS lexemes
        FROM "ChunkLexicalDoc" l WHERE l."chunkId" = ${chunk.id}::uuid
      `;
      const lexemes = new Set(((stored[0]?.lexemes || []) as string[]).map(fromIndexTerm));
      expect([...expected].sort()).toEqual(
        [...((stored[0]?.lexemes || []) as string[])].sort(),
      );
      expect([...lexemes].sort()).toEqual(tokenize(chunk.content).sort());
    }

    const coverage = await lexicalCoverage(prisma as any, [KB_A, KB_B]);
    expect(coverage.indexed).toBe(coverage.chunks);
  }, 120_000);

  it('re-indexing the same document leaves the statistics unchanged', async () => {
    const before = await prisma.$queryRaw<any[]>`
      SELECT COALESCE(sum("df"), 0)::int AS total, count(*)::int AS terms
      FROM "LexicalTermStat" WHERE "kbId" = ${KB_A}::uuid
    `;
    const doc: any[] = await prisma.$queryRaw`
      SELECT id, "documentId" FROM "Chunk" WHERE "kbId" = ${KB_A}::uuid LIMIT 1
    `;
    const chunks: Array<{ id: string; content: string }> = await prisma.$queryRaw`
      SELECT id, content FROM "Chunk" WHERE "documentId" = ${doc[0].documentId}::uuid
    `;
    await indexDocumentChunks(prisma as any, KB_A, String(doc[0].documentId), chunks);
    const after = await prisma.$queryRaw<any[]>`
      SELECT COALESCE(sum("df"), 0)::int AS total, count(*)::int AS terms
      FROM "LexicalTermStat" WHERE "kbId" = ${KB_A}::uuid
    `;
    expect(after[0].total).toBe(before[0].total);
    expect(after[0].terms).toBe(before[0].terms);
  }, 60_000);
});
