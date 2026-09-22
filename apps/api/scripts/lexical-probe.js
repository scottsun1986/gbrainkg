#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const lexical_index_store_1 = require("../src/retrieval/lexical-index-store");
const lexical_tokenizer_1 = require("../src/retrieval/lexical-tokenizer");
async function main() {
    const argv = process.argv.slice(2);
    const urlIndex = argv.indexOf('--database-url');
    const urlInline = argv.find((a) => a.startsWith('--database-url='));
    const databaseUrl = urlInline
        ? urlInline.slice('--database-url='.length)
        : urlIndex >= 0
            ? argv[urlIndex + 1]
            : undefined;
    const isValueOfFlag = (value) => (urlIndex >= 0 && argv[urlIndex + 1] === value) || value.startsWith('postgres');
    const query = argv.find((a) => !a.startsWith('--') && !isValueOfFlag(a)) || '员工报销交通费标准';
    const kbArg = argv.find((a) => a.startsWith('--kbs='));
    const limitArg = argv.find((a) => a.startsWith('--limit='));
    const repeatArg = argv.find((a) => a.startsWith('--repeat='));
    const limit = limitArg ? Number(limitArg.split('=')[1]) : 10;
    const repeat = repeatArg ? Number(repeatArg.split('=')[1]) : 3;
    const prisma = databaseUrl
        ? new client_1.PrismaClient({ datasources: { db: { url: databaseUrl } } })
        : new client_1.PrismaClient();
    try {
        const kbs = kbArg
            ? kbArg.split('=')[1].split(',').filter(Boolean)
            : await (async () => {
                try {
                    return (await prisma.$queryRaw `SELECT id FROM "KnowledgeBase"`).map((r) => String(r.id));
                }
                catch {
                    return (await prisma.$queryRaw `SELECT DISTINCT "kbId" FROM "Chunk"`).map((r) => String(r.kbId ?? r.kbid));
                }
            })();
        const terms = (0, lexical_tokenizer_1.tokenizeQuery)(query);
        console.log(`query="${query}" scope=${kbs.length} KBs terms=${terms.length}`);
        console.log(`terms: ${terms.slice(0, 40).join(' ')}`);
        console.log(`index sample: ${(0, lexical_tokenizer_1.tokenize)('员工报销交通费标准第12条 EQ-0077').join(' ')}`);
        const latencies = [];
        let hits = [];
        for (let i = 0; i < repeat; i += 1) {
            const started = Date.now();
            hits = await (0, lexical_index_store_1.searchLexicalBm25)(prisma, kbs, terms, limit);
            latencies.push(Date.now() - started);
        }
        latencies.sort((a, b) => a - b);
        console.log(`latency ms: min=${latencies[0]} p50=${latencies[Math.floor(latencies.length / 2)]} max=${latencies[latencies.length - 1]}`);
        console.log(`hits=${hits.length}`);
        for (const hit of hits) {
            console.log(`  ${hit.score.toFixed(3)}  ${hit.document.title.slice(0, 40)}  #${hit.ord}  ${hit.content.replace(/\s+/g, ' ').slice(0, 60)}`);
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
//# sourceMappingURL=lexical-probe.js.map