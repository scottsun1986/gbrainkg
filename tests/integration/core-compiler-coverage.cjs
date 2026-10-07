const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { getPrismaClient, disconnectPrismaClient } = require('../../apps/api/dist/prisma');
const { BrainScopeService } = require('../../apps/api/dist/brain-compiler/brain-scope.service');
const { scanDeterministicChunks } = require('../../apps/api/dist/chat/deterministic-scan');
const { sourceKeyForKnowledgeBase } = require('../../apps/api/dist/brain-compiler/brain-source');
const { runAsService } = require('../../apps/api/dist/db/service-principal');
const { reconcileIncrementalGraph, withCommunityInputs } = require('../../apps/api/dist/graph-rag/incremental-projection');
const { filterReadableArtifacts } = require('../../apps/api/dist/permission/artifact-read-guard');

async function main() {
  const db = getPrismaClient();
  const [{ name }] = await db.$queryRaw`SELECT current_database() AS name`;
  assert.match(name, /^gbrain_core_opt_test/);
  process.env.BRAIN_SCOPE_FULL_COVERAGE = '1'; process.env.GBRAIN_SCOPE_SYNTHESIZE_ENABLED = '1';
  const userId = randomUUID(), scopeId = randomUUID(), kbIds = Array.from({ length: 6 }, () => randomUUID()), docIds = Array.from({ length: 6 }, () => randomUUID());
  const sourceIds = [];
  await db.user.create({ data: { id: userId, username: userId, email: `${userId}@invalid.test`, displayName: 'Compiler fixture' } });
  try {
    for (let index = 0; index < 6; index++) {
      const kbId = kbIds[index], documentId = docIds[index];
      await db.knowledgeBase.create({ data: { id: kbId, type: 'personal', name: `Fixture ${index}`, ownerUserId: userId, gitRepoUrl: 'test://compiler' } });
      await db.document.create({ data: { id: documentId, kbId, title: `Document ${index}`, mdPath: 'fixture.md', sourceType: 'upload', status: 'published', contentHash: `source-${index}`, effectiveFrom: new Date('2026-01-01'), supersedesDocumentId: null } });
      const count = index === 0 ? 21001 : 41;
      await db.$executeRaw`INSERT INTO "Chunk" (id,"documentId","kbId",ord,content,"tokenCount","charStart","charEnd",metadata)
        SELECT gen_random_uuid(),${documentId}::uuid,${kbId}::uuid,n,'Fixture paragraph ' || n::text,5,n*20,n*20+19,'{}'::jsonb FROM generate_series(0,${count - 1}) n`;
      const source = await db.brainSource.create({ data: { sourceKey: sourceKeyForKnowledgeBase(kbId), kind: 'private', scopeKey: `kb:${kbId}` } });
      sourceIds.push(source.id);
      await db.brainSourceDocument.create({ data: { sourceId: source.id, documentId, syncedVersion: 1 } });
    }
    // Synthetic vectors exercise SQL mechanics only; no quality claim.
    const vector = JSON.stringify(Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0));
    await db.$executeRaw`UPDATE "Chunk" SET embedding=${vector}::vector WHERE "documentId"=ANY(${docIds}::uuid[]) AND ord=0`;
    await db.brainScope.create({ data: { id: scopeId, fingerprint: randomUUID(), status: 'dirty', sourceKeys: kbIds.map(sourceKeyForKnowledgeBase) } });
    let syntheses = 0;
    let mutateDuringSynthesis = false;
    const adapter = {
      initializeSource: async () => {}, ingest: async () => {},
      synthesize: async sourceRef => {
        syntheses++;
        const docs = await db.document.findMany({ where: { id: { in: docIds } }, orderBy: { id: 'asc' }, select: { id: true, version: true, contentHash: true } });
        if (mutateDuringSynthesis) { mutateDuringSynthesis = false; await db.document.update({ where: { id: docIds[0] }, data: { version: { increment: 1 }, contentHash: randomUUID() } }); }
        return { answer: JSON.stringify({ sourceRef, docs }), synthesis_status: 'fixture' };
      },
    };
    const compiler = new BrainScopeService({}, undefined, adapter);
    const first = await compiler.compileScopeDerived(scopeId);
    assert.equal(first.derivedPagesCount, 4); assert.equal(syntheses, 6);
    let pages = await db.brainDerivedPage.findMany({ where: { scopeId } });
    const summary = pages.find(page => page.slug === 'derived/scope-summary');
    assert.equal(summary.derivedFrom.find(source => source.docId === docIds[0]).chunkCount, 21001);
    assert.equal(summary.derivedFrom.every(source => source.coverage === 'complete'), true);
    assert.equal(JSON.parse(pages.find(page => page.slug === 'derived/topic-relations').content).relations.length, 30);
    assert.equal(JSON.parse(pages.find(page => page.slug === 'derived/truth-diff').content).baseline, 'missing');
    await db.document.update({ where: { id: docIds[0] }, data: { version: 2, contentHash: 'changed-source' } });
    await db.brainScope.update({ where: { id: scopeId }, data: { status: 'dirty', knowledgeEpoch: { increment: 1 } } });
    await compiler.compileScopeDerived(scopeId);
    pages = await db.brainDerivedPage.findMany({ where: { scopeId } });
    const diff = JSON.parse(pages.find(page => page.slug === 'derived/truth-diff').content);
    assert.equal(diff.baseline, 'present'); assert.equal(diff.changed, true); assert(diff.sourcesChanged.includes(docIds[0]));
    assert(diff.addedLineCount > 0); assert(diff.removedLineCount > 0);
    await db.brainScope.update({ where: { id: scopeId }, data: { status: 'dirty' } }); mutateDuringSynthesis = true;
    await assert.rejects(compiler.compileScopeDerived(scopeId), /inputs changed/);
    assert.equal((await db.brainScope.findUnique({ where: { id: scopeId } })).status, 'dirty');

    const where = { documentId: docIds[0], kbId: { in: [kbIds[0]] }, document: { status: 'published' } };
    const startedAt = performance.now();
    const scan = await scanDeterministicChunks(db, where, 25000, 1000);
    const scanMs = performance.now() - startedAt;
    assert.equal(scan.length, 21001); assert.equal(new Set(scan.map(row => row.id)).size, 21001);
    let edited = false;
    const concurrentDb = { $transaction: (work, options) => db.$transaction(tx => work({ ...tx, chunk: {
      count: args => tx.chunk.count(args), findMany: async args => {
        const rows = await tx.chunk.findMany(args);
        if (!edited) { edited = true; await db.chunk.deleteMany({ where: { documentId: docIds[0], ord: 17000 } }); }
        return rows;
      },
    } }), options) };
    const concurrent = await scanDeterministicChunks(concurrentDb, where, 25000, 1000);
    assert.equal(concurrent.length, 21001, 'one RepeatableRead snapshot keeps deleted later-page rows');
    assert.equal((await scanDeterministicChunks(db, where, 25000)).length, 21000, 'next snapshot sees committed edit');

    const extract = async doc => ({ entities: [{ name: 'A', type: 'concept' }, { name: 'B', type: 'concept' }], relations: [{ sourceName: 'A', targetName: 'B', relationType: 'mentions', provenanceDocId: doc.id, snippet: 'fixture relation' }] });
    await runAsService('community-fixture', () => reconcileIncrementalGraph(db, kbIds[1], ['fixture'], false, extract));
    const cluster = await db.graphEntity.findMany({ where: { kbId: kbIds[1] }, include: { outgoingRelations: true } });
    const community = await runAsService('community-fixture', () => withCommunityInputs(db, cluster, tx => tx.graphCommunity.create({ data: { kbId: kbIds[1], title: 'Fixture', summary: 'Fixture summary', entityIds: cluster.map(entity => entity.id) } })));
    assert((await db.$transaction(tx => filterReadableArtifacts(userId, [{ id: community.id, kbId: kbIds[1] }], 'GraphCommunity', tx))).has(community.id));
    await db.document.update({ where: { id: docIds[1] }, data: { contentHash: 'changed-after-projection' } });
    await assert.rejects(runAsService('community-fixture', () => withCommunityInputs(db, cluster, tx => tx.graphCommunity.create({ data: { kbId: kbIds[1], title: 'Obsolete', summary: 'must rollback' } }))), /versions changed/);
    assert.equal(await db.graphCommunity.count({ where: { kbId: kbIds[1] } }), 1);
    console.log(JSON.stringify({ status: 'passed', scopeSources: 6, derivedPages: 4, completeChunks: 21001, scanMs, scopeTruthDiff: true, nativeTopicRelations: true, concurrentSnapshot: true, communityManifest: true }));
  } finally {
    await db.brainScope.deleteMany({ where: { id: scopeId } });
    await db.brainSource.deleteMany({ where: { id: { in: sourceIds } } });
    await db.graphCommunity.deleteMany({ where: { kbId: { in: kbIds } } });
    await db.graphRelation.deleteMany({ where: { kbId: { in: kbIds } } });
    await db.graphEntity.deleteMany({ where: { kbId: { in: kbIds } } });
    await db.knowledgeBase.deleteMany({ where: { id: { in: kbIds } } });
    await db.user.deleteMany({ where: { id: userId } });
    await disconnectPrismaClient();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
