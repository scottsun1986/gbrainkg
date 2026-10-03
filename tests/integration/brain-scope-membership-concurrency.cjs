/* Run against a disposable/local test database after pnpm --filter api build.
 * BRAIN_SCOPE_MEMBERSHIP_TEST=1 DATABASE_URL=... node tests/integration/brain-scope-membership-concurrency.cjs
 */
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
if (process.env.BRAIN_SCOPE_MEMBERSHIP_TEST !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Explicit test opt-in and DATABASE_URL are required');
}
const root = path.resolve(__dirname, '../..');
const { PrismaClient } = require(path.join(root, 'apps/api/node_modules/@prisma/client'));
const { BrainScopeService } = require(path.join(root, 'apps/api/dist/brain-compiler/brain-scope.service'));
const { sourceKeyForKnowledgeBase } = require(path.join(root, 'apps/api/dist/brain-compiler/brain-source'));
const prisma = new PrismaClient();
(async () => {
  const id = randomUUID();
  let user, kb, scopeId;
  try {
    user = await prisma.user.create({data:{username:`scope-test-${id}`,displayName:'Scope concurrency fixture',email:`${id}@example.invalid`}});
    kb = await prisma.knowledgeBase.create({data:{name:`scope-fixture-${id}`,type:'personal',ownerUserId:user.id,gitRepoUrl:`fixture://${id}`}});
    const sourceKeys = [sourceKeyForKnowledgeBase(kb.id)];
    const fingerprint = createHash('sha256').update(sourceKeys.join(',')).digest('hex').slice(0,16);
    scopeId = (await prisma.brainScope.create({data:{fingerprint,sourceKeys,strategy:'lazy',status:'active'}})).id;
    const service = Object.create(BrainScopeService.prototype);
    service.prisma = prisma;
    service.permissionService = {getVisibleKnowledgeBases:async () => [kb.id]};
    const outcomes = await Promise.allSettled(Array.from({length:20}, () => service.resolveUserScope(user.id)));
    assert.ok(outcomes.every(r => r.status === 'fulfilled'), 'Every initial concurrent resolution must succeed');
    const results = outcomes.map(r => r.value);
    assert.ok(results.every(r => r.scopeId === scopeId));
    const before = await prisma.brainScopeMember.findMany({where:{userId:user.id}});
    assert.equal(before.length, 1);
    const repeated = await Promise.allSettled(Array.from({length:20}, () => service.resolveUserScope(user.id)));
    assert.ok(repeated.every(r => r.status === 'fulfilled'));
    const after = await prisma.brainScopeMember.findMany({where:{userId:user.id}});
    assert.equal(after.length, 1);
    assert.deepEqual(after[0], before[0], 'Repeated resolution must preserve membership timestamps');
    console.log('40 concurrent/repeated scope resolutions passed; one unchanged membership');
  } finally {
    if (scopeId) await prisma.brainScope.delete({where:{id:scopeId}});
    if (kb) await prisma.knowledgeBase.delete({where:{id:kb.id}});
    if (user) await prisma.user.delete({where:{id:user.id}});
    await prisma.$disconnect();
  }
})().catch(error => {console.error(error.name, error.message);process.exitCode=1;});
