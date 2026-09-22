#!/usr/bin/env node
/**
 * Consistency check between the tokenizer output, the stored postings and the
 * corpus statistics. Reports per-document deltas so a mismatch can be traced
 * to the exact chunk.
 */
import { PrismaClient } from '@prisma/client';
import { tokenize } from '../src/retrieval/lexical-tokenizer';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const kb = process.argv[2];
    const docs = await prisma.document.findMany({
      where: kb ? { kbId: kb } : {},
      select: { id: true, kbId: true, title: true, chunks: { select: { id: true, content: true } } },
      take: 4000,
      orderBy: { id: 'asc' },
    });
    let checked = 0;
    let mismatches = 0;
    for (const doc of docs) {
      for (const chunk of doc.chunks) {
        const expected = new Set(tokenize(chunk.content));
        const rows: any[] = await prisma.$queryRaw`
          SELECT array_length(array(SELECT u.lexeme FROM unnest(l."tsv") AS u(lexeme, positions, weights)), 1) AS n,
                 array(SELECT u.lexeme FROM unnest(l."tsv") AS u(lexeme, positions, weights)) AS lexemes
          FROM "ChunkLexicalDoc" l WHERE l."chunkId" = ${chunk.id}::uuid
        `;
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row) continue;
        checked += 1;
        const lexemes = new Set((row.lexemes || []) as string[]);
        const missing = [...expected].filter((t) => !lexemes.has(t));
        const extra = [...lexemes].filter((t) => !expected.has(t));
        if (missing.length || extra.length) {
          mismatches += 1;
          if (mismatches <= 5) {
            console.log(
              `chunk ${chunk.id} (${chunk.content.length} chars, ${expected.size} expected, ${lexemes.size} stored) ` +
                `missing=${missing.slice(0, 8).join(',')} extra=${extra.slice(0, 8).join(',')}`,
            );
          }
        }
      }
    }
    console.log(`checked ${checked} chunks, ${mismatches} mismatching`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
