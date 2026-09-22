/**
 * Operational CLI for the PostgreSQL full-corpus BM25 index.
 *
 * Compiled by `nest build`, so production runs it with plain Node and no extra
 * tooling or network access:
 *
 *   node dist/bootstrap/lexical-index-cli.js --backfill
 *   node dist/bootstrap/lexical-index-cli.js --backfill --rebuild-stats
 *   node dist/bootstrap/lexical-index-cli.js --backfill --kbs=<uuid>,<uuid>
 *   node dist/bootstrap/lexical-index-cli.js --verify
 *
 * `--verify` compares the tokenizer output, the stored postings and the term
 * statistics for every chunk and exits non-zero on any disagreement, so it can
 * be used as a release gate.
 */
import { disconnectPrismaClient, getPrismaClient } from '../prisma';
import {
  ensureKbStats,
  toIndexTerm,
  indexDocumentChunks,
  lexicalIndexHealth,
  refreshKbStat,
} from '../retrieval/lexical-index-store';
import { tokenize } from '../retrieval/lexical-tokenizer';

interface Options {
  mode: 'backfill' | 'verify';
  kbs: string[];
  documentId?: string;
  rebuildStats: boolean;
  pageSize: number;
}

function parseArgs(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    mode: argv.includes('--verify') ? 'verify' : 'backfill',
    kbs: (value('kbs') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    documentId: value('document-id'),
    rebuildStats: argv.includes('--rebuild-stats'),
    pageSize: Number(value('page-size') || 200) || 200,
  };
}

async function backfill(prisma: any, options: Options): Promise<void> {
  const started = Date.now();
  let documents = 0;
  let chunks = 0;
  const touchedKbs = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const where: Record<string, unknown> = {};
    if (options.documentId) where.id = options.documentId;
    if (options.kbs.length) where.kbId = { in: options.kbs };
    const page = await prisma.document.findMany({
      where,
      select: {
        id: true,
        kbId: true,
        chunks: { select: { id: true, content: true }, orderBy: { ord: 'asc' } },
      },
      orderBy: { id: 'asc' },
      take: options.pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!page.length) break;
    cursor = page[page.length - 1].id;

    for (const document of page) {
      if (!document.chunks.length) continue;
      await indexDocumentChunks(prisma, document.kbId, document.id, document.chunks);
      documents += 1;
      chunks += document.chunks.length;
      touchedKbs.add(document.kbId);
    }
    process.stdout.write(`\rindexed documents=${documents} chunks=${chunks}`);
    if (options.documentId) break;
    if (page.length < options.pageSize) break;
  }

  for (const kbId of touchedKbs) {
    if (options.rebuildStats) {
      await ensureKbStats(prisma, kbId, { force: true });
    } else {
      await refreshKbStat(prisma, kbId);
    }
  }
  const seconds = (Date.now() - started) / 1000;
  process.stdout.write('\n');
  const health = await lexicalIndexHealth(prisma);
  console.log(
    JSON.stringify(
      {
        mode: 'backfill',
        documents,
        chunks,
        knowledgeBases: touchedKbs.size,
        seconds: Number(seconds.toFixed(1)),
        chunksPerSecond: Number((chunks / Math.max(seconds, 0.001)).toFixed(1)),
        health,
      },
      null,
      2,
    ),
  );
}

async function verify(prisma: any): Promise<number> {
  const health = await lexicalIndexHealth(prisma);
  const chunks: Array<{ id: string; content: string }> = await prisma.$queryRaw`
    SELECT id, content FROM "Chunk" ORDER BY id
  `;
  let mismatches = 0;
  for (const chunk of chunks) {
    const expected = new Set(tokenize(chunk.content).map(toIndexTerm));
    const rows: any[] = await prisma.$queryRaw`
      SELECT array(SELECT u.lexeme FROM unnest(l."tsv") AS u(lexeme, positions, weights)) AS lexemes
      FROM "ChunkLexicalDoc" l WHERE l."chunkId" = ${chunk.id}::uuid
    `;
    if (!rows.length) {
      mismatches += 1;
      console.error(`chunk ${chunk.id}: no postings`);
      continue;
    }
    const lexemes = new Set((rows[0].lexemes || []) as string[]);
    const missing = [...expected].filter((term) => !lexemes.has(term));
    const extra = [...lexemes].filter((term) => !expected.has(term));
    if (missing.length || extra.length) {
      mismatches += 1;
      if (mismatches <= 5) {
        console.error(
          `chunk ${chunk.id}: missing=[${missing.slice(0, 5).join(',')}] extra=[${extra.slice(0, 5).join(',')}]`,
        );
      }
    }
  }
  const consistent = health.chunks === health.indexed && mismatches === 0;
  const statsRows: any[] = await prisma.$queryRaw`
    SELECT
      (SELECT count(*)::int FROM "ChunkLexicalDoc" l
         CROSS JOIN LATERAL unnest(l."tsv") AS u(lexeme, positions, weights)) AS postings,
      (SELECT COALESCE(sum(df), 0)::bigint FROM "LexicalTermStat") AS stat_df
  `;
  const stats = statsRows[0];
  const statsMatch = Number(stats.postings) === Number(stats.stat_df);
  console.log(
    JSON.stringify(
      {
        mode: 'verify',
        chunks: health.chunks,
        indexed: health.indexed,
        postings: Number(stats.postings),
        statDf: Number(stats.stat_df),
        terms: health.terms,
        mismatchedChunks: mismatches,
        statsMatch,
        consistent: consistent && statsMatch,
      },
      null,
      2,
    ),
  );
  return consistent && statsMatch ? 0 : 1;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prisma = getPrismaClient();
  if (options.mode === 'verify') {
    process.exitCode = await verify(prisma);
  } else {
    await backfill(prisma, options);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrismaClient);
