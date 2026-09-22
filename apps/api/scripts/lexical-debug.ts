#!/usr/bin/env node
/** Explain one lexical miss: query terms vs the source chunk's indexed terms. */
import { PrismaClient } from '@prisma/client';
import { searchLexicalBm25Detailed } from '../src/retrieval/lexical-index-store';
import { tokenize, tokenizeQuery } from '../src/retrieval/lexical-tokenizer';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const chunkId = process.argv[2];
    const chunk: any = await prisma.chunk.findUnique({
      where: { id: chunkId },
      select: { id: true, content: true, kbId: true, document: { select: { title: true } } },
    });
    if (!chunk) {
      console.log('chunk not found');
      return;
    }
    const content = String(chunk.content);
    const start = Math.max(0, Math.floor(content.length / 2) - 12);
    const query = content.slice(start, start + 24).trim();
    const queryTerms = tokenizeQuery(query);
    const indexTerms = new Set(tokenize(content));
    const rows: any[] = await prisma.$queryRaw`
      SELECT array(SELECT u.lexeme FROM unnest(l."tsv") AS u(lexeme, positions, weights)) AS lexemes
      FROM "ChunkLexicalDoc" l WHERE l."chunkId" = ${chunkId}::uuid
    `;
    const stored = new Set(((rows[0]?.lexemes as string[]) || []));
    const result = await searchLexicalBm25Detailed(prisma, [String(chunk.kbId)], queryTerms, 50, {
      window: 2000,
      timeoutMs: 10000,
    });
    const rank = result.hits.findIndex((h) => h.id === chunk.id) + 1;
    console.log(`doc=${chunk.document?.title}`);
    console.log(`content[${content.length}]=${content.slice(0, 80)}...`);
    console.log(`query="${query}"`);
    console.log(`queryTerms=${queryTerms.join(' ')}`);
    console.log(`allInIndex=${queryTerms.every((t) => stored.has(t))}`);
    console.log(`missingFromIndex=${queryTerms.filter((t) => !stored.has(t)).join(',') || '-'}`);
    console.log(
      `tokenizerVsStored=${[...indexTerms].filter((t) => !stored.has(t)).length} extra, ` +
        `${[...stored].filter((t) => !indexTerms.has(t)).length} missing`,
    );
    console.log(`rank=${rank > 0 ? rank : 'not-in-top-50'} candidates=${result.stats.candidates} termsKept=${result.stats.termsKept}/${result.stats.termsKept + result.stats.termsDropped}`);
    for (const hit of result.hits.slice(0, 3)) {
      console.log(`  ${hit.score.toFixed(2)} ${hit.content.replace(/\s+/g, ' ').slice(0, 50)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
