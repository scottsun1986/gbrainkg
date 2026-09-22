#!/usr/bin/env node
/**
 * Source-chunk recall for the full-corpus BM25 channel.
 *
 * For a random sample of sufficiently long chunks it builds a query from a
 * substring of the chunk itself (a proxy for "the user typed a phrase that
 * really is in one specific place") and reports whether the source chunk comes
 * back in the top-K. This is the measurement that decides whether the lexical
 * channel loses matches it should have found.
 *
 *   npx tsx scripts/lexical-recall-eval.ts --samples=150 --query-chars=24
 */
import { PrismaClient } from '@prisma/client';
import { searchLexicalBm25Detailed } from '../src/retrieval/lexical-index-store';
import { tokenizeQuery } from '../src/retrieval/lexical-tokenizer';
import { createHash } from 'node:crypto';
import { tokenize } from '../src/retrieval/lexical-tokenizer';

function arg(name: string, fallback: number): number {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
}

async function main(): Promise<void> {
  const samples = arg('samples', 150);
  const queryChars = arg('query-chars', 24);
  const topK = arg('top-k', 10);
  const prisma = new PrismaClient();
  try {
    const chunks: any[] = await prisma.$queryRaw`
      SELECT c.id, c.content, c."kbId", d.title
      FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
      WHERE d.status = 'published' AND length(c.content) > ${queryChars + 60}
      ORDER BY md5(c.id::text)
      LIMIT ${samples}
    `;
    // The local corpus contains many byte-identical synthetic chunks; counting
    // only the original chunk id would score corpus duplication, not the
    // channel. A hit is therefore "a chunk with the same normalised content is
    // in the top-K", and a separate figure is reported for chunks whose content
    // is unique in the corpus.
    const signature = (text: string): string =>
      createHash('sha1').update(String(text).replace(/\s+/g, '')).digest('hex');
    // Containment of the source's indexed terms: near-identical boilerplate
    // records (the local corpus is full of them) count as a hit, because the
    // ranking question is "did the channel find this place", not "did it pick
    // record 2409 rather than record 2408".
    const tokenSet = (text: string): Set<string> => new Set(tokenize(text));
    const containment = (hitTokens: Set<string>, sourceTokens: Set<string>): number => {
      let shared = 0;
      for (const token of sourceTokens) if (hitTokens.has(token)) shared += 1;
      return shared / Math.max(sourceTokens.size, 1);
    };
    const uniqueness = new Map<string, number>();
    for (const chunk of chunks) {
      const key = signature(chunk.content);
      uniqueness.set(key, (uniqueness.get(key) || 0) + 1);
    }
    let evaluated = 0;
    let hits = 0;
    let uniqueEvaluated = 0;
    let uniqueHits = 0;
    const ranks: number[] = [];
    const misses: string[] = [];
    for (const chunk of chunks) {
      const content = String(chunk.content);
      const start = Math.floor(content.length / 2) - Math.floor(queryChars / 2);
      const query = content.slice(Math.max(0, start), Math.max(0, start) + queryChars).trim();
      const terms = tokenizeQuery(query);
      if (terms.length < 2) continue;
      evaluated += 1;
      const result = await searchLexicalBm25Detailed(prisma, [String(chunk.kbId)], terms, 50, {
        window: arg('window', 2000),
        timeoutMs: arg('timeout-ms', 10000),
      });
      const wanted = signature(content);
      const sourceTokens = tokenSet(content);
      const sourceTokensForCompare = new Set(tokenize(query));
      const position = result.hits.findIndex(
        (h) =>
          signature(h.content) === wanted ||
          containment(tokenSet(h.content), sourceTokensForCompare) >= 0.9,
      );
      const isUnique = (uniqueness.get(wanted) || 0) === 1;
      if (isUnique) {
        uniqueEvaluated += 1;
        if (position >= 0) uniqueHits += 1;
      }
      if (position >= 0) {
        hits += 1;
        ranks.push(position + 1);
        if (position + 1 > topK) misses.push(`${chunk.id} rank=${position + 1}`);
      } else {
        misses.push(`${chunk.id} not-found`);
      }
    }
    const within = ranks.filter((r) => r <= topK).length;
    console.log(
      `queries=${evaluated} found=${hits} (${(hits / Math.max(evaluated, 1)).toFixed(4)}) ` +
        `recall@${topK}=${(within / Math.max(evaluated, 1)).toFixed(4)} meanRank=${(
          ranks.reduce((a, b) => a + b, 0) / Math.max(ranks.length, 1)
        ).toFixed(2)}`,
    );
    console.log(
      `unique-content subset: queries=${uniqueEvaluated} found=${uniqueHits} ` +
        `recall@50=${(uniqueHits / Math.max(uniqueEvaluated, 1)).toFixed(4)}`,
    );
    if (misses.length) {
      console.log(`first misses: ${misses.slice(0, 5).join(' | ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
