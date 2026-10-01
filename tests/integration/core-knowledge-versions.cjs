const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { withStrictOutputPermit } = require('../../apps/api/dist/permission/strict-output-permit');
const { DocumentVersionStore } = require('../../apps/api/dist/ingestion/document-version-store');
const { getPrismaClient, disconnectPrismaClient } = require('../../apps/api/dist/prisma');

async function main() {
  const db = getPrismaClient();
  const identity = await db.$queryRaw`SELECT current_database() AS name`;
  assert.match(identity[0].name, /^gbrain_core_opt_test/);
  const userId = randomUUID(), kbId = randomUUID(), documentId = randomUUID();
  const store = new DocumentVersionStore(db);
  await db.user.create({ data: { id: userId, username: userId, displayName: 'Version fixture', email: `${userId}@invalid.test` } });
  await db.knowledgeBase.create({ data: { id: kbId, type: 'personal', name: 'Isolated immutable version test', ownerUserId: userId, gitRepoUrl: 'test://core-versions' } });
  try {
    await db.document.create({ data: { id: documentId, kbId, title: 'v1', mdPath: 'test/v1.md', sourceType: 'upload', ingestVersion: 1 } });
    const stage = number => store.stage({ documentId, kbId, number, sourceHash: `source-${number}`, title: `v${number}`, mdPath: `test/v${number}.md`, parser: 'test-parser', passed: true,
      publicationData: { contentHash: `source-${number}` }, blocks: [{ ord: 0, content: `# Version ${number}\n\nImmutable evidence number ${number}.`, tokenCount: 20, charStart: 0, charEnd: 52, metadata: { fixture: true } }] });
    const embed = versionId => db.$executeRaw`UPDATE "BlockArtifact" SET embedding=${JSON.stringify(Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0))}::vector, embedding_fingerprint='fixture-model-v1' WHERE "versionId"=${versionId}::uuid`;
    const v1 = await stage(1); await embed(v1.id);
    assert.equal(await store.publish(v1.id, 'fixture-model-v1'), true);
    assert.match((await db.chunk.findFirst({ where: { documentId } })).content, /Version 1/);
    await db.document.update({ where: { id: documentId }, data: { ingestVersion: 2 } });
    const v2 = await stage(2);
    // Missing core coverage rolls back publication and keeps the old projection.
    await assert.rejects(store.publish(v2.id, 'fixture-model-v1'), /coverage incomplete/);
    assert.equal((await db.document.findUnique({ where: { id: documentId } })).activeVersionId, v1.id);
    assert.match((await db.chunk.findFirst({ where: { documentId } })).content, /Version 1/);
    await embed(v2.id);
    await db.document.update({ where: { id: documentId }, data: { ingestVersion: 3 } });
    const v3 = await stage(3); await embed(v3.id);
    assert.equal(await store.publish(v2.id, 'fixture-model-v1'), false, 'stale job must not publish');
    assert.equal(await store.publish(v3.id, 'fixture-model-v1'), true);
    assert.equal(await store.publish(v3.id, 'fixture-model-v1'), true, 'duplicate delivery is idempotent');
    const current = await db.document.findUnique({ where: { id: documentId } });
    assert.equal(current.activeVersionId, v3.id); assert.equal(current.version, 3);
    const chunks = await db.chunk.findMany({ where: { documentId } });
    assert.equal(chunks.length, 1); assert.match(chunks[0].content, /Version 3/);
    const generations = await db.indexGeneration.findMany({ where: { versionId: v3.id } });
    assert.equal(generations.length, 2);
    for (const generation of generations) { assert.equal(generation.state, 'ready'); assert.equal(generation.readyCount, generation.expectedCount); assert.equal(generation.manifestHash, v3.manifestHash); }
    assert.equal(await db.blockArtifact.count({ where: { versionId: v1.id } }), 1, 'historical original retained');
    const firstGeneration = generations.find(g => g.channel === 'dense');
    await db.$executeRaw`UPDATE "BlockArtifact" SET embedding=${JSON.stringify(Array.from({ length: 1024 }, (_, i) => i === 1 ? 1 : 0))}::vector, embedding_fingerprint='fixture-model-v2' WHERE "versionId"=${v3.id}::uuid`;
    const secondGeneration = await store.buildDenseGeneration(v3.id, 'fixture-model-v2');
    let projection = await db.$queryRaw`SELECT embedding_fingerprint AS fingerprint FROM "Chunk" WHERE "documentId"=${documentId}::uuid`;
    assert.equal(projection[0].fingerprint, 'fixture-model-v1', 'build must not replace live vectors');
    assert.equal(await store.activateDenseGeneration(v3.id, secondGeneration), true);
    projection = await db.$queryRaw`SELECT embedding_fingerprint AS fingerprint FROM "Chunk" WHERE "documentId"=${documentId}::uuid`;
    assert.equal(projection[0].fingerprint, 'fixture-model-v2');
    assert.equal(await store.activateDenseGeneration(v3.id, firstGeneration.id), true);
    const rolledBack = await db.$queryRaw`SELECT embedding_fingerprint AS fingerprint, embedding::text AS vector FROM "Chunk" WHERE "documentId"=${documentId}::uuid`;
    assert.equal(rolledBack[0].fingerprint, 'fixture-model-v1');
    assert.match(rolledBack[0].vector, /^\[1,0,0,/);
    assert.equal(await store.activateDenseGeneration(v1.id, firstGeneration.id), false, 'index rollback cannot revive an obsolete source version');
    const [auth] = await db.$queryRaw`SELECT revision,"policyVersion" FROM "AuthorizationState" WHERE id=1`;
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const drain = new Promise(resolve => { release = resolve; });
    const permit = withStrictOutputPermit(userId, { revision: String(auth.revision), policyVersion: auth.policyVersion, expiresAt: Infinity }, async () => { entered(); await drain; });
    await enteredPromise;
    let committed = false;
    const revoke = db.document.update({ where: { id: documentId }, data: { aclMode: 'restricted' } }).then(() => { committed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(committed, false, 'revoke cannot commit while strict bytes drain');
    release(); await permit; await revoke;
    let leaked = false;
    await assert.rejects(withStrictOutputPermit(userId, { revision: String(auth.revision), policyVersion: auth.policyVersion, expiresAt: Infinity }, async () => { leaked = true; }), /Authorization changed/);
    assert.equal(leaked, false, 'revoked revision never emits buffered content');
    console.log('Generation build/switch/rollback and real strict-output/revoke commit serialization passed.');

    console.log('Immutable publication: coverage rollback, old-version availability, stale fencing, duplicate delivery, two-channel manifest all passed.');
  } finally {
    await db.knowledgeBase.delete({ where: { id: kbId } });
    await db.user.delete({ where: { id: userId } });
    await disconnectPrismaClient();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
