#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const lexical_index_store_1 = require("../src/retrieval/lexical-index-store");
const lexical_tokenizer_1 = require("../src/retrieval/lexical-tokenizer");
const node_crypto_1 = require("node:crypto");
const lexical_tokenizer_2 = require("../src/retrieval/lexical-tokenizer");
function arg(name, fallback) {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found ? Number(found.split('=')[1]) : fallback;
}
async function main() {
    const samples = arg('samples', 150);
    const queryChars = arg('query-chars', 24);
    const topK = arg('top-k', 10);
    const prisma = new client_1.PrismaClient();
    try {
        const chunks = await prisma.$queryRaw `
      SELECT c.id, c.content, c."kbId", d.title
      FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
      WHERE d.status = 'published' AND length(c.content) > ${queryChars + 60}
      ORDER BY md5(c.id::text)
      LIMIT ${samples}
    `;
        const signature = (text) => (0, node_crypto_1.createHash)('sha1').update(String(text).replace(/\s+/g, '')).digest('hex');
        const tokenSet = (text) => new Set((0, lexical_tokenizer_2.tokenize)(text));
        const containment = (hitTokens, sourceTokens) => {
            let shared = 0;
            for (const token of sourceTokens)
                if (hitTokens.has(token))
                    shared += 1;
            return shared / Math.max(sourceTokens.size, 1);
        };
        const uniqueness = new Map();
        for (const chunk of chunks) {
            const key = signature(chunk.content);
            uniqueness.set(key, (uniqueness.get(key) || 0) + 1);
        }
        let evaluated = 0;
        let hits = 0;
        let uniqueEvaluated = 0;
        let uniqueHits = 0;
        const ranks = [];
        const misses = [];
        for (const chunk of chunks) {
            const content = String(chunk.content);
            const start = Math.floor(content.length / 2) - Math.floor(queryChars / 2);
            const query = content.slice(Math.max(0, start), Math.max(0, start) + queryChars).trim();
            const terms = (0, lexical_tokenizer_1.tokenizeQuery)(query);
            if (terms.length < 2)
                continue;
            evaluated += 1;
            const result = await (0, lexical_index_store_1.searchLexicalBm25Detailed)(prisma, [String(chunk.kbId)], terms, 50, {
                window: arg('window', 2000),
                timeoutMs: arg('timeout-ms', 10000),
            });
            const wanted = signature(content);
            const sourceTokens = tokenSet(content);
            const sourceTokensForCompare = new Set((0, lexical_tokenizer_2.tokenize)(query));
            const position = result.hits.findIndex((h) => signature(h.content) === wanted ||
                containment(tokenSet(h.content), sourceTokensForCompare) >= 0.9);
            const isUnique = (uniqueness.get(wanted) || 0) === 1;
            if (isUnique) {
                uniqueEvaluated += 1;
                if (position >= 0)
                    uniqueHits += 1;
            }
            if (position >= 0) {
                hits += 1;
                ranks.push(position + 1);
                if (position + 1 > topK)
                    misses.push(`${chunk.id} rank=${position + 1}`);
            }
            else {
                misses.push(`${chunk.id} not-found`);
            }
        }
        const within = ranks.filter((r) => r <= topK).length;
        console.log(`queries=${evaluated} found=${hits} (${(hits / Math.max(evaluated, 1)).toFixed(4)}) ` +
            `recall@${topK}=${(within / Math.max(evaluated, 1)).toFixed(4)} meanRank=${(ranks.reduce((a, b) => a + b, 0) / Math.max(ranks.length, 1)).toFixed(2)}`);
        console.log(`unique-content subset: queries=${uniqueEvaluated} found=${uniqueHits} ` +
            `recall@50=${(uniqueHits / Math.max(uniqueEvaluated, 1)).toFixed(4)}`);
        if (misses.length) {
            console.log(`first misses: ${misses.slice(0, 5).join(' | ')}`);
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
//# sourceMappingURL=lexical-recall-eval.js.map