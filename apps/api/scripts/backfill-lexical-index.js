#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const lexical_index_store_1 = require("../src/retrieval/lexical-index-store");
const lexical_tokenizer_1 = require("../src/retrieval/lexical-tokenizer");
function parseArgs(argv) {
    const args = { kbs: [], staleOnly: false, rebuildStats: false, pageSize: 200, chunkBatch: 500 };
    for (const raw of argv) {
        if (raw.startsWith('--kbs=')) {
            args.kbs = raw
                .slice('--kbs='.length)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
        else if (raw.startsWith('--document-id=')) {
            args.documentId = raw.slice('--document-id='.length).trim();
        }
        else if (raw === '--stale-only') {
            args.staleOnly = true;
        }
        else if (raw === '--rebuild-stats') {
            args.rebuildStats = true;
        }
        else if (raw.startsWith('--page-size=')) {
            args.pageSize = Number(raw.slice('--page-size='.length)) || 200;
        }
        else if (raw.startsWith('--chunk-batch=')) {
            args.chunkBatch = Number(raw.slice('--chunk-batch='.length)) || 500;
        }
    }
    return args;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const prisma = new client_1.PrismaClient();
    const started = Date.now();
    let documents = 0;
    let chunks = 0;
    const touchedKbs = new Set();
    let cursor;
    try {
        let staleIds = null;
        if (args.staleOnly) {
            const rows = args.kbs.length
                ? await prisma.$queryRaw `
            SELECT d.id
            FROM "Document" d
            JOIN "Chunk" c ON c."documentId" = d.id
            LEFT JOIN "ChunkLexicalDoc" l ON l."chunkId" = c.id
            WHERE l."chunkId" IS NULL AND d."kbId" = ANY(${args.kbs}::uuid[])
            GROUP BY d.id
          `
                : await prisma.$queryRaw `
            SELECT d.id
            FROM "Document" d
            JOIN "Chunk" c ON c."documentId" = d.id
            LEFT JOIN "ChunkLexicalDoc" l ON l."chunkId" = c.id
            WHERE l."chunkId" IS NULL
            GROUP BY d.id
          `;
            staleIds = rows.map((r) => String(r.id));
            console.log(`Stale documents detected: ${staleIds.length}`);
            if (!staleIds.length)
                return;
        }
        let staleCursor = 0;
        for (;;) {
            const where = {};
            if (args.documentId)
                where.id = args.documentId;
            if (args.kbs.length)
                where.kbId = { in: args.kbs };
            if (staleIds) {
                where.id = { in: staleIds.slice(staleCursor, staleCursor + args.pageSize) };
                staleCursor += args.pageSize;
                if (!where.id.in.length)
                    break;
            }
            const page = await prisma.document.findMany({
                where,
                select: { id: true, kbId: true, chunks: { select: { id: true, content: true }, orderBy: { ord: 'asc' } } },
                orderBy: { id: 'asc' },
                take: args.pageSize,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
            if (!page.length)
                break;
            cursor = page[page.length - 1].id;
            for (const doc of page) {
                if (!doc.chunks.length)
                    continue;
                await (0, lexical_index_store_1.indexDocumentChunks)(prisma, doc.kbId, doc.id, doc.chunks, args.chunkBatch);
                documents += 1;
                chunks += doc.chunks.length;
                touchedKbs.add(doc.kbId);
            }
            process.stdout.write(`\rindexed documents=${documents} chunks=${chunks}`);
            if (args.documentId)
                break;
            if (page.length < args.pageSize)
                break;
        }
        for (const kbId of touchedKbs) {
            if (args.rebuildStats) {
                await (0, lexical_index_store_1.ensureKbStats)(prisma, kbId, { force: true });
            }
            else {
                await (0, lexical_index_store_1.refreshKbStat)(prisma, kbId);
            }
        }
        process.stdout.write('\n');
        const elapsed = (Date.now() - started) / 1000;
        console.log(`Backfill complete: ${documents} documents, ${chunks} chunks, ${touchedKbs.size} knowledge bases in ${elapsed.toFixed(1)}s ` +
            `(${(chunks / Math.max(elapsed, 0.001)).toFixed(0)} chunks/s).`);
        console.log(`Sample tokens for "交通费报销标准": ${(0, lexical_tokenizer_1.tokenize)('交通费报销标准').join(' ')}`);
    }
    finally {
        await prisma.$disconnect();
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=backfill-lexical-index.js.map