#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const lexical_tokenizer_1 = require("../src/retrieval/lexical-tokenizer");
const lexical_index_store_1 = require("../src/retrieval/lexical-index-store");
async function main() {
    const argv = process.argv.slice(2);
    const inline = argv.find((a) => a.startsWith('--database-url='));
    const index = argv.indexOf('--database-url');
    const url = inline ? inline.slice('--database-url='.length) : index >= 0 ? argv[index + 1] : undefined;
    const prisma = url
        ? new client_1.PrismaClient({ datasources: { db: { url } } })
        : new client_1.PrismaClient();
    try {
        const totals = await prisma.$queryRaw `
      SELECT
        (SELECT count(*)::int FROM "Chunk") AS chunks,
        (SELECT count(*)::int FROM "ChunkLexicalDoc") AS indexed,
        (SELECT COALESCE(sum(df), 0)::bigint FROM "LexicalTermStat") AS stat_df,
        (SELECT count(*)::int FROM "ChunkLexicalDoc" l
           CROSS JOIN LATERAL unnest(l."tsv") AS u(lexeme, positions, weights)) AS postings
    `;
        const summary = totals[0];
        console.log(`chunks=${summary.chunks} indexed=${summary.indexed} postings=${summary.postings} stat_df=${Number(summary.stat_df)}`);
        const cursorRows = await prisma.$queryRaw `
      SELECT id, content FROM "Chunk" ORDER BY id
    `;
        let mismatches = 0;
        let checked = 0;
        for (const chunk of cursorRows) {
            const expected = new Set((0, lexical_tokenizer_1.tokenize)(chunk.content).map(lexical_index_store_1.toIndexTerm));
            const stored = await prisma.$queryRaw `
        SELECT array(SELECT u.lexeme FROM unnest(l."tsv") AS u(lexeme, positions, weights)) AS lexemes
        FROM "ChunkLexicalDoc" l WHERE l."chunkId" = ${chunk.id}::uuid
      `;
            checked += 1;
            if (!stored.length) {
                mismatches += 1;
                console.error(`chunk ${chunk.id}: no postings`);
                continue;
            }
            const lexemes = new Set((stored[0].lexemes || []));
            const missing = [...expected].filter((term) => !lexemes.has(term));
            const extra = [...lexemes].filter((term) => !expected.has(term));
            if (missing.length || extra.length) {
                mismatches += 1;
                if (mismatches <= 5) {
                    console.error(`chunk ${chunk.id}: missing=[${missing.slice(0, 5).join(',')}] extra=[${extra.slice(0, 5).join(',')}]`);
                }
            }
        }
        const consistent = Number(summary.chunks) === Number(summary.indexed) &&
            Number(summary.postings) === Number(summary.stat_df) &&
            mismatches === 0;
        console.log(`checked=${checked} mismatches=${mismatches} consistent=${consistent}`);
        process.exit(consistent ? 0 : 1);
    }
    finally {
        await prisma.$disconnect();
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=lexical-verify-all.js.map