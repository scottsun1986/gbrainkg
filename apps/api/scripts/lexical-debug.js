#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const lexical_index_store_1 = require("../src/retrieval/lexical-index-store");
const lexical_tokenizer_1 = require("../src/retrieval/lexical-tokenizer");
async function main() {
    const prisma = new client_1.PrismaClient();
    try {
        const chunkId = process.argv[2];
        const chunk = await prisma.chunk.findUnique({
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
        const queryTerms = (0, lexical_tokenizer_1.tokenizeQuery)(query);
        const indexTerms = new Set((0, lexical_tokenizer_1.tokenize)(content));
        const rows = await prisma.$queryRaw `
      SELECT array(SELECT u.lexeme FROM unnest(l."tsv") AS u(lexeme, positions, weights)) AS lexemes
      FROM "ChunkLexicalDoc" l WHERE l."chunkId" = ${chunkId}::uuid
    `;
        const stored = new Set((rows[0]?.lexemes || []));
        const result = await (0, lexical_index_store_1.searchLexicalBm25Detailed)(prisma, [String(chunk.kbId)], queryTerms, 50, {
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
        console.log(`tokenizerVsStored=${[...indexTerms].filter((t) => !stored.has(t)).length} extra, ` +
            `${[...stored].filter((t) => !indexTerms.has(t)).length} missing`);
        console.log(`rank=${rank > 0 ? rank : 'not-in-top-50'} candidates=${result.stats.candidates} termsKept=${result.stats.termsKept}/${result.stats.termsKept + result.stats.termsDropped}`);
        for (const hit of result.hits.slice(0, 3)) {
            console.log(`  ${hit.score.toFixed(2)} ${hit.content.replace(/\s+/g, ' ').slice(0, 50)}`);
        }
    }
    finally {
        await prisma.$disconnect();
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=lexical-debug.js.map