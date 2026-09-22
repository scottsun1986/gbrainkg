#!/usr/bin/env node
/**
 * Seeds an isolated benchmark schema with a large synthetic corpus and runs the
 * *real* production indexing code over it.
 *
 *   npx tsx scripts/scale-seed.ts --schema=scale_bench --chunks=100000 --kb-count=40
 *
 * Why a separate schema: the platform rule is that nothing may disturb live
 * data, so the benchmark owns one schema and drops/recreates only that schema.
 * Passing `--schema=public` is refused.
 *
 * The seeder is deliberately not a mock: documents and chunks are written with
 * the same Prisma calls ingestion uses, the lexical postings are written by
 * `indexDocumentChunks` (the function the request path and the backfill CLI
 * share), so throughput, failure rate and index sizes are measurements of the
 * shipping implementation rather than of a model of it.
 */
import { PrismaClient } from '@prisma/client';
import { bulkIndexDocumentChunks, indexDocumentChunks } from '../src/retrieval/lexical-index-store';
import { tokenize } from '../src/retrieval/lexical-tokenizer';

interface Options {
  schema: string;
  chunks: number;
  kbCount: number;
  batch: number;
  /** Documents flushed per bulkIndexDocumentChunks call. */
  lexicalFlush: number;
  seed: number;
  /** Skip embedding backfill + index build (lexical-only smoke run). */
  skipVector: boolean;
  /** Keep an existing schema whose chunk count already matches --chunks. */
  resume: boolean;
  out?: string;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback?: string): string | undefined => {
    const found = argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
  };
  return {
    schema: get('schema', 'scale_bench') as string,
    chunks: Number(get('chunks', '100000')),
    kbCount: Number(get('kb-count', '40')),
    batch: Number(get('batch', '2000')),
    lexicalFlush: Number(get('lexical-flush', '50')),
    seed: Number(get('seed', '20260919')),
    skipVector: argv.includes('--skip-vector'),
    resume: argv.includes('--resume'),
    out: get('out'),
  };
}

/** Deterministic PRNG so the same seed reproduces the same corpus. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAIN_TERMS = [
  '制度', '流程', '审批', '报销', '预算', '采购', '合同', '法务', '合规', '审计',
  '安全', '生产', '设备', '检修', '维护', '质量', '标准', '验收', '交付', '项目经理',
  '考勤', '绩效', '培训', '招聘', '薪酬', '职级', '调岗', '离职', '假期', '加班',
  '财务', '会计', '凭证', '发票', '税务', '资金', '结算', '成本', '折旧', '资产',
  '网络', '服务器', '数据库', '备份', '容灾', '权限', '账号', '日志', '监控', '告警',
  '数据', '接口', '版本', '发布', '回滚', '测试', '缺陷', '需求', '评审', '架构',
  '客户', '合同', '交付物', '里程碑', '风险', '变更', '验收报告', '会议纪要', '决策', '备案',
  '环境', '排放', '能耗', '应急', '预案', '演练', '事故', '隐患', '整改', '督查',
];
const CONNECTORS = ['的', '和', '与', '及', '或者', '以及', '按照', '根据', '应当', '不得'];
const TEMPLATES = [
  '第{n}条 {a}{b}应当由{c}部门负责{d}，并在{e}个工作日内完成。',
  '第{n}条 关于{a}{b}的管理要求：{c}负责{d}，{e}负责复核。',
  '{n}. 涉及{a}{b}时应按{c}流程办理，由{d}归档留存。',
  '第{n}条 {a}{b}的{c}标准为{d}，异常情况需报{e}审批。',
];

function makeChunkText(rand: () => number, index: number): string {
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const zipf: () => number = () => {
    // Zipf-ish term choice: a few terms dominate, which is what makes corpus df
    // (and therefore BM25 IDF) meaningful in the benchmark.
    const r = rand();
    return Math.floor(DOMAIN_TERMS.length * Math.pow(r, 3));
  };
  const sentences: string[] = [];
  const sentenceCount = 2 + Math.floor(rand() * 4);
  for (let s = 0; s < sentenceCount; s += 1) {
    const template = pick(TEMPLATES);
    sentences.push(
      template
        .replace('{n}', String(index * 7 + s + 1))
        .replace('{a}', DOMAIN_TERMS[zipf()])
        .replace('{b}', DOMAIN_TERMS[zipf()])
        .replace('{c}', DOMAIN_TERMS[zipf()])
        .replace('{d}', `${pick(CONNECTORS)}${DOMAIN_TERMS[zipf()]}${DOMAIN_TERMS[zipf()]}`)
        .replace('{e}', String(1 + Math.floor(rand() * 30))),
    );
  }
  return `# ${DOMAIN_TERMS[zipf()]}${DOMAIN_TERMS[zipf()]}实施细则\n\n${sentences.join('\n\n')}`;
}

const SCHEMA_DDL = (schema: string): string[] => [
  `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
  // The two application tables are cloned from the live schema (columns,
  // defaults and NOT NULL constraints) and only their indexes are added later,
  // so the benchmark never drifts from what production ingests into. Sequences
  // and foreign keys are intentionally not copied: the benchmark loads in
  // batches and owns its own isolation.
  `CREATE TABLE IF NOT EXISTS "${schema}"."Document"
     (LIKE public."Document" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
  `CREATE TABLE IF NOT EXISTS "${schema}"."Chunk"
     (LIKE public."Chunk" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
  // LIKE copies columns and defaults, not primary keys. Production has
  // Chunk.id as its primary key and an index on (kbId, documentId), and the
  // ingestion delete path relies on that index; without it the benchmark would
  // measure a schema artifact instead of the real workload.
  `ALTER TABLE "${schema}"."Document" ADD CONSTRAINT "Document_pkey" PRIMARY KEY (id)`,
  `ALTER TABLE "${schema}"."Chunk" ADD CONSTRAINT "Chunk_pkey" PRIMARY KEY (id)`,
  `CREATE INDEX IF NOT EXISTS bench_chunk_document_idx ON "${schema}"."Chunk" ("documentId")`,
  `CREATE INDEX IF NOT EXISTS bench_chunk_kb_document_idx ON "${schema}"."Chunk" ("kbId", "documentId")`,
  `CREATE TABLE IF NOT EXISTS "${schema}"."ChunkLexicalDoc" (
     "chunkId" uuid PRIMARY KEY, "kbId" uuid NOT NULL, "documentId" uuid NOT NULL,
     "len" integer NOT NULL, tsv tsvector NOT NULL, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "${schema}"."LexicalTermStat" (
     "kbId" uuid NOT NULL, term text NOT NULL, df integer NOT NULL DEFAULT 0,
     "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("kbId", term))`,
  `CREATE TABLE IF NOT EXISTS "${schema}"."KbLexicalStat" (
     "kbId" uuid PRIMARY KEY, "docCount" integer NOT NULL DEFAULT 0, "totalLen" bigint NOT NULL DEFAULT 0,
     "statsVersion" integer NOT NULL DEFAULT 0, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE OR REPLACE FUNCTION "${schema}".lexical_tsquery(terms text[]) RETURNS tsquery AS $$
   DECLARE joined text;
   BEGIN
     SELECT string_agg(quote_literal(t), ' | ') INTO joined FROM unnest(terms) AS t;
     IF joined IS NULL OR joined = '' THEN RETURN NULL; END IF;
     RETURN to_tsquery('simple', joined);
   END; $$ LANGUAGE plpgsql IMMUTABLE`,
];

// PostgreSQL does not accept a schema-qualified index name (the index always
// lands in its table's schema), so the names stay unqualified and the harness
// verifies afterwards that the index really exists in the benchmark schema.
const INDEX_DDL = (schema: string): string[] => [
  `CREATE INDEX IF NOT EXISTS bench_lexical_kbid_idx ON "${schema}"."ChunkLexicalDoc" ("kbId")`,
  `CREATE INDEX IF NOT EXISTS bench_lexical_document_idx ON "${schema}"."ChunkLexicalDoc" ("documentId")`,
  `CREATE INDEX IF NOT EXISTS bench_lexical_tsv_gin_idx ON "${schema}"."ChunkLexicalDoc" USING gin (tsv)`,
  `CREATE INDEX IF NOT EXISTS bench_lexical_kbid_len_idx ON "${schema}"."ChunkLexicalDoc" ("kbId","len")`,
  `CREATE INDEX IF NOT EXISTS bench_lexical_term_idx ON "${schema}"."LexicalTermStat" (term)`,
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!/^[a-z_][a-z0-9_]*$/i.test(options.schema) || options.schema === 'public') {
    throw new Error('Refusing to run: --schema must be a dedicated benchmark schema, never "public".');
  }
  const baseUrl = process.env.DATABASE_URL || 'postgresql://llmwiki:llmwiki_pass@localhost:5433/llmwiki';
  const url = new URL(baseUrl);
  url.searchParams.set('schema', options.schema);
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  const stats: Record<string, any> = { schema: options.schema, chunks: options.chunks, steps: {} };
  const rand = mulberry32(options.seed);

  try {
    // 1. Fresh isolated schema (or keep a complete one when resuming).
    let resumeExisting = false;
    if (options.resume) {
      try {
        const rows: any[] = await admin.$queryRawUnsafe(
          `SELECT count(*)::int AS chunks FROM "${options.schema}"."Chunk"`,
        );
        resumeExisting = Number(rows?.[0]?.chunks || 0) >= options.chunks;
      } catch {
        resumeExisting = false;
      }
    }
    if (!resumeExisting) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${options.schema}" CASCADE`);
      for (const statement of SCHEMA_DDL(options.schema)) {
        await admin.$executeRawUnsafe(statement);
      }
    }
    stats.resumed = resumeExisting;

    // 2. Documents.
    const kbIds = Array.from({ length: options.kbCount }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(12, '0');
      return `11111111-1111-4111-8111-${hex}`;
    });
    const chunkTarget = options.chunks;
    const chunksPerDoc = 4;
    const docCount = Math.ceil(chunkTarget / chunksPerDoc);
    const docIds: string[] = [];
    if (resumeExisting) {
      stats.steps.documents = { count: docCount, seconds: 0, resumed: true };
      stats.steps.chunks = { written: options.chunks, failed: 0, successRate: 1, resumed: true };
    } else {
    const docStarted = Date.now();
    for (let i = 0; i < docCount; i += 1000) {
      const rows = [];
      for (let j = i; j < Math.min(i + 1000, docCount); j += 1) {
        const id = `22222222-2222-4222-8222-${j.toString(16).padStart(12, '0')}`;
        docIds.push(id);
        rows.push({
          id,
          kbId: kbIds[j % kbIds.length],
          mdPath: `/synthetic/${id}/content.md`,
          sourceType: 'synthetic',
          title: `${DOMAIN_TERMS[j % DOMAIN_TERMS.length]}${DOMAIN_TERMS[(j * 7) % DOMAIN_TERMS.length]}管理办法-${j}`,
          status: 'published',
          version: 1,
          indexReadiness: 'ready',
        });
      }
      await prisma.document.createMany({ data: rows });
    }
    stats.steps.documents = { count: docCount, seconds: (Date.now() - docStarted) / 1000 };

    // 3. Chunks + real lexical index maintenance.
    let chunkIndex = 0;
    let written = 0;
    let failed = 0;
    let pendingLexical: Array<{ kbId: string; documentId: string; rows: Array<{ id: string; content: string }> }> = [];
    let pendingChunks: any[] = [];
    const chunkStarted = Date.now();
    for (let docPosition = 0; docPosition < docIds.length; docPosition += 1) {
      const docId = docIds[docPosition];
      const kbId = kbIds[docPosition % kbIds.length];
      const rows = [];
      for (let c = 0; c < chunksPerDoc && chunkIndex < chunkTarget; c += 1) {
        const content = makeChunkText(rand, chunkIndex);
        rows.push({
          id: `33333333-3333-4333-8333-${chunkIndex.toString(16).padStart(12, '0')}`,
          documentId: docId,
          kbId,
          ord: c,
          content,
          tokenCount: tokenize(content).length,
          charStart: 0,
          charEnd: content.length,
          metadata: { synthetic: true },
        });
        chunkIndex += 1;
      }
      try {
        pendingChunks.push(...rows);
        pendingLexical.push({
          kbId,
          documentId: docId,
          rows: rows.map((row) => ({ id: row.id, content: row.content })),
        });
        written += rows.length;
        // Multi-document flush: one createMany + one lexical transaction per
        // N documents instead of 1+5-8 statements per 4-chunk document.
        if (pendingLexical.length >= options.lexicalFlush) {
          if (pendingChunks.length) {
            await prisma.chunk.createMany({ data: pendingChunks });
            pendingChunks = [];
          }
          await bulkIndexDocumentChunks(prisma as any, pendingLexical, options.batch);
          pendingLexical = [];
        }
      } catch (err) {
        failed += rows.length;
        console.error(`seeding failure: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (written % 10000 === 0) {
        process.stdout.write(`\rindexed ${written}/${chunkTarget} chunks`);
      }
    }
    if (pendingChunks.length) {
      await prisma.chunk.createMany({ data: pendingChunks });
      pendingChunks = [];
    }
    if (pendingLexical.length) {
      await bulkIndexDocumentChunks(prisma as any, pendingLexical, options.batch);
      pendingLexical = [];
    }
    process.stdout.write('\n');
    const chunkSeconds = (Date.now() - chunkStarted) / 1000;
    stats.steps.chunks = {
      written,
      failed,
      successRate: written / Math.max(written + failed, 1),
      seconds: chunkSeconds,
      chunksPerSecond: written / Math.max(chunkSeconds, 0.001),
    };
    }

    // 4. Lexical indexes.
    const ginStarted = Date.now();
    for (const statement of INDEX_DDL(options.schema)) {
      await admin.$executeRawUnsafe(statement);
    }
    stats.steps.lexicalIndexes = { seconds: (Date.now() - ginStarted) / 1000 };

    if (!options.skipVector) {
      // 5. Embeddings: reuse the real corpus distribution (perturbed pairs of
      //    stored vectors) instead of uniform noise, so HNSW behaves like it
      //    does on production data.
      const embedStarted = Date.now();
      const poolSizeRows: any[] = await admin.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM public."Chunk" WHERE embedding IS NOT NULL LIMIT 4000) AS s`,
      );
      const poolSize = Number(poolSizeRows?.[0]?.n || 1);
      // pgvector exposes element-wise vector arithmetic, so the two sampled
      // vectors are averaged through a constant 0.5 vector rather than a scalar
      // multiply (which this extension build does not provide).
      const halfVector = `[${Array(1024).fill('0.5').join(',')}]`;
      // The pool index is derived from a hash of the chunk id, which keeps the
      // right-hand side of both join conditions independent of the pool table
      // so PostgreSQL can hash-join instead of nested-looping 100k x 4000.
      await admin.$executeRawUnsafe(`
        WITH pool AS (
          SELECT row_number() OVER (ORDER BY id) AS rn, embedding
          FROM (SELECT id, embedding FROM public."Chunk" WHERE embedding IS NOT NULL LIMIT 4000) AS source
        )
        UPDATE "${options.schema}"."Chunk" c
        SET embedding = (((a.embedding + b.embedding) * '${halfVector}'::vector))::vector
        FROM pool a, pool b
        WHERE a.rn = 1 + (abs(('x' || substr(md5(c.id::text), 1, 8))::bit(32)::int) % ${poolSize})
          AND b.rn = 1 + (abs(('x' || substr(md5(c.id::text || 'b'), 1, 8))::bit(32)::int) % ${poolSize})
      `);
      stats.steps.embeddings = {
        seconds: (Date.now() - embedStarted) / 1000,
        note: 'real embeddings reused (pairwise average); no synthetic noise vectors',
      };

      const hnswStarted = Date.now();
      await admin.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
        ON "${options.schema}"."Chunk" USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
      stats.steps.hnswIndex = { seconds: (Date.now() - hnswStarted) / 1000 };
    }

    // 6. Sizes and consistency.
    const sizeRows: any[] = await admin.$queryRawUnsafe(`
      SELECT
        pg_size_pretty(pg_total_relation_size('"${options.schema}"."Chunk"')) AS chunk_table,
        pg_total_relation_size('"${options.schema}"."Chunk"') AS chunk_bytes,
        pg_size_pretty(pg_total_relation_size('"${options.schema}"."ChunkLexicalDoc"')) AS lexical_table,
        pg_size_pretty(pg_total_relation_size('"${options.schema}"."LexicalTermStat"')) AS term_stat_table,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${options.schema}' AND c.relkind = 'i') AS index_count
    `);
    stats.sizes = sizeRows[0];

    const consistencyRows: any[] = await admin.$queryRawUnsafe(`
      SELECT
        (SELECT count(*)::int FROM "${options.schema}"."Chunk") AS chunks,
        (SELECT count(*)::int FROM "${options.schema}"."ChunkLexicalDoc") AS postings,
        (SELECT COALESCE(sum(df),0)::bigint FROM "${options.schema}"."LexicalTermStat") AS stat_df,
        (SELECT count(*)::int FROM "${options.schema}"."LexicalTermStat") AS terms,
        (SELECT count(*)::int FROM "${options.schema}"."Chunk" WHERE embedding IS NOT NULL) AS embedded
    `);
    stats.consistency = consistencyRows[0];
    stats.indexConsistent = Number(consistencyRows[0].chunks) === Number(consistencyRows[0].postings);

    const text = JSON.stringify(
      stats,
      (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
      2,
    );
    console.log(text);
    if (options.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(options.out, `${text}\n`, 'utf8');
    }
  } finally {
    await prisma.$disconnect();
    await admin.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
