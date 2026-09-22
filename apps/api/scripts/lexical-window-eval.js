#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const lexical_index_store_1 = require("../src/retrieval/lexical-index-store");
const lexical_tokenizer_1 = require("../src/retrieval/lexical-tokenizer");
function arg(name, fallback) {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found ? Number(found.split('=')[1]) : fallback;
}
function percentile(values, p) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
async function main() {
    const samples = arg('samples', 60);
    const limit = arg('limit', 10);
    const queryChars = arg('query-chars', 220);
    const prisma = new client_1.PrismaClient();
    try {
        const chunks = await prisma.$queryRaw `
      SELECT c.id, c.content, d.title, c."kbId"
      FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
      WHERE d.status = 'published' AND length(c.content) > 120
      ORDER BY md5(c.id::text)
      LIMIT ${samples}
    `;
        const windows = [0, 500, 1000, 2000, 4000];
        const overlaps = new Map();
        const recalls = new Map();
        const latencies = new Map();
        let evaluated = 0;
        for (const chunk of chunks) {
            const terms = (0, lexical_tokenizer_1.tokenizeQuery)(`${chunk.title || ''} ${String(chunk.content).slice(0, queryChars)}`);
            if (terms.length < 3)
                continue;
            const scope = [String(chunk.kbId)];
            const exact = await (0, lexical_index_store_1.searchLexicalBm25Detailed)(prisma, scope, terms, limit, { window: 0 });
            if (!exact.hits.length)
                continue;
            evaluated += 1;
            const exactIds = new Set(exact.hits.map((h) => h.id));
            for (const window of windows) {
                const result = window === 0
                    ? exact
                    : await (0, lexical_index_store_1.searchLexicalBm25Detailed)(prisma, scope, terms, limit, { window });
                const ids = result.hits.map((h) => h.id);
                const overlap = ids.filter((id) => exactIds.has(id)).length / Math.max(exactIds.size, 1);
                overlaps.set(window, [...(overlaps.get(window) || []), overlap]);
                recalls.set(window, [...(recalls.get(window) || []), ids.includes(String(chunk.id)) ? 1 : 0]);
                latencies.set(window, [...(latencies.get(window) || []), result.stats.elapsedMs]);
            }
        }
        console.log(`queries evaluated: ${evaluated} (query chars=${queryChars}, limit=${limit})`);
        console.log('window\tmeanTop10Overlap\tsourceRecall@10\tp50ms\tp95ms\tcandidates(mean)');
        for (const window of windows) {
            const overlap = overlaps.get(window) || [0];
            const recall = recalls.get(window) || [0];
            const lat = latencies.get(window) || [0];
            const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
            console.log(`${window === 0 ? 'exact' : window}\t${mean(overlap).toFixed(4)}\t${mean(recall).toFixed(4)}\t` +
                `${percentile(lat, 50)}\t${percentile(lat, 95)}\t-`);
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
//# sourceMappingURL=lexical-window-eval.js.map