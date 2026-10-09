/**
 * F09: atomic version-switch publish benchmark.
 *
 * Measures the transaction that switches a document's live read projection to
 * a new immutable version when the publish path must read every block, verify
 * the manifest, delete the old projection, insert the new one, rebuild lexical
 * contributions and snapshot dense vectors. Correctness is already strong; the
 * question this benchmark answers is whether the single transaction becomes a
 * lock/latency bottleneck at realistic block counts, BEFORE any generational
 * pointer redesign is attempted.
 *
 * Measured per run: publish wall time, WAL bytes produced, concurrent-reader
 * latency (p50/p95/max) during the switch, and the resulting chunk count.
 *
 * Safety: refuses to run unless DATABASE_URL points at a local
 * `gbrain_core_opt_test*` database. The fixture KB/document/version is deleted
 * in finally, so the database is left as found. This is a local benchmark; its
 * numbers must not be reported as production capacity without the same
 * measurement on production-class hardware.
 *
 * Usage:
 *   PUBLISH_BENCH_BLOCKS=2000 npx --yes tsx@4.23.13 scripts/publish-switch-benchmark.ts
 *   PUBLISH_BENCH_BLOCKS=20000 PUBLISH_BENCH_REPORT=/tmp/opencode/publish-switch.json ...
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DocumentVersionStore, type StagedBlock } from '../src/ingestion/document-version-store';

const DIM = 1024;

function assertLocalTestDatabase(url: string | undefined): void {
  const value = String(url || '').toLowerCase();
  if (!/(localhost|127\.0\.0\.1)/.test(value) || !/gbrain_core_opt_test/.test(value)) {
    throw new Error(
      'Refusing to run: publish-switch-benchmark requires DATABASE_URL on localhost with a gbrain_core_opt_test* database name.',
    );
  }
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[index];
}

async function main(): Promise<void> {
  assertLocalTestDatabase(process.env.DATABASE_URL);
  const blockCount = Math.max(100, Math.min(200_000, Number(process.env.PUBLISH_BENCH_BLOCKS || 2000)));
  const fingerprint = process.env.PUBLISH_BENCH_FINGERPRINT || `bench-${Date.now()}`;
  const prisma = new PrismaClient();
  const store = new DocumentVersionStore(prisma as any);
  const kbId = randomUUID();
  const documentId = randomUUID();

  try {
    await prisma.knowledgeBase.create({
      data: { id: kbId, type: 'personal', name: `publish-bench-${blockCount}`, gitRepoUrl: '' },
    });
    await prisma.document.create({
      data: {
        id: documentId, kbId, mdPath: `${documentId}/bench.v1.md`, title: `publish-bench-${blockCount}.md`,
        sourceType: 'upload', status: 'parsing', version: 1, ingestVersion: 1,
        contentHash: createHash('sha256').update(`bench-${blockCount}`).digest('hex'),
      },
    });

    // Deterministic, realistic-shape blocks: each carries enough text to index.
    const blocks: StagedBlock[] = [];
    let charStart = 0;
    for (let ord = 0; ord < blockCount; ord += 1) {
      const content = `第${ord + 1}条：这是一段用于原子发布压力验证的确定性文本，编号 ${ord} 的唯一标记 ${Math.imul(ord, 2654435761) >>> 0}。`;
      blocks.push({ ord, content, tokenCount: Math.max(1, Math.ceil(content.length / 4)), charStart, charEnd: charStart + content.length, metadata: {} });
      charStart += content.length + 1;
    }

    const version = await store.stage({
      documentId, kbId, number: 1, sourceHash: `bench-source-${blockCount}`, title: `publish-bench-${blockCount}.md`,
      mdPath: `${documentId}/bench.v1.md`, parser: 'publish-benchmark',
      publicationData: { parserEngine: 'publish-benchmark' },
      blocks, passed: true,
    });
    if (!version?.id) throw new Error('stage returned no version');

    // Dense coverage: zero vectors are sufficient to exercise the copy/snapshot
    // path; embedding quality is not what this benchmark measures.
    await prisma.$executeRawUnsafe(
      `UPDATE "BlockArtifact" SET embedding = array_fill(0::real, ARRAY[${DIM}]::int[])::vector, embedding_fingerprint = $1 WHERE "versionId" = $2::uuid`,
      fingerprint, version.id,
    );

    const walBefore = await prisma.$queryRaw<Array<{ lsn: string }>>`SELECT pg_current_wal_lsn()::text AS lsn`;
    let readerStop = false;
    const readLatencies: number[] = [];
    const reader = (async () => {
      while (!readerStop) {
        const started = Date.now();
        await prisma.$queryRaw`SELECT count(*)::int AS c FROM "Chunk" WHERE "documentId"=${documentId}::uuid`;
        readLatencies.push(Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    const publishStarted = Date.now();
    const published = await store.publish(version.id, fingerprint);
    const publishMs = Date.now() - publishStarted;
    readerStop = true;
    await reader;

    const walAfter = await prisma.$queryRaw<Array<{ lsn: string }>>`SELECT pg_current_wal_lsn()::text AS lsn`;
    const walDelta = await prisma.$queryRaw<Array<{ bytes: bigint }>>`
      SELECT pg_wal_lsn_diff(${walAfter[0].lsn}::pg_lsn, ${walBefore[0].lsn}::pg_lsn)::bigint AS bytes`;
    const chunkCount = await prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT count(*)::bigint AS c FROM "Chunk" WHERE "documentId"=${documentId}::uuid`;
    const blockers = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*)::bigint AS waiting FROM pg_locks WHERE NOT granted`;
    const sorted = readLatencies.slice().sort((a, b) => a - b);

    const report = {
      schemaVersion: 1,
      benchmark: 'atomic-version-switch-publish',
      environment: { database: 'local-gbrain_core_opt_test', dimension: DIM },
      blocks: blockCount,
      published,
      publishMs,
      walBytes: Number(walDelta[0]?.bytes ?? 0),
      concurrentReads: {
        samples: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      },
      chunkCountAfter: Number(chunkCount[0]?.c ?? 0),
      ungrantedLocksAfter: Number(blockers[0]?.waiting ?? 0),
      note: 'Local benchmark only; not production capacity evidence.',
    };
    const serialized = JSON.stringify(report, null, 2);
    if (process.env.PUBLISH_BENCH_REPORT) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(process.env.PUBLISH_BENCH_REPORT, serialized + '\n', 'utf8');
    }
    process.stdout.write(serialized + '\n');
  } finally {
    // Cascades remove versions, block artifacts, chunks and lexical postings.
    await prisma.knowledgeBase.deleteMany({ where: { id: kbId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
