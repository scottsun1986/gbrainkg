const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { getPrismaClient, disconnectPrismaClient } = require('../../apps/api/dist/prisma');
const { PermissionService } = require('../../apps/api/dist/permission/permission.service');
const { DocumentAclService } = require('../../apps/api/dist/permission/document-acl.service');
const { validateEvidenceDependenciesInClient } = require('../../apps/api/dist/permission/evidence-dependencies');

async function main() {
  const db = getPrismaClient();
  const [{ name }] = await db.$queryRaw`SELECT current_database() AS name`;
  assert.match(name, /^gbrain_core_opt_test/);
  const ids = Array.from({ length: 12 }, () => randomUUID());
  const [owner, reader, admin, privateKb, industryKb, publicDoc, secretDoc, orgRoot, orgChild, orgSibling, orgKb, roleId] = ids;
  const siblingKb = randomUUID();
  let createdAdminRole;
  const perm = new PermissionService();
  const acl = new DocumentAclService(perm);
  const visible = user => perm.getVisibleKnowledgeBases(user, db); // Explicit fresh application authority.
  const readable = user => acl.filterReadableDocuments(user, [publicDoc, secretDoc], { prisma: db });
  try {
    for (const id of [owner, reader, admin]) await db.user.create({ data: { id, username: id, displayName: 'ACL fixture', email: `${id}@invalid.test` } });
    let systemRole = await db.role.findUnique({ where: { code: 'system_admin' } });
    if (!systemRole) {
      systemRole = await db.role.create({ data: { name: `System fixture ${admin}`, code: 'system_admin', permissions: ['*'] } });
      createdAdminRole = systemRole.id;
    }
    await db.userRole.create({ data: { userId: admin, roleId: systemRole.id } });
    await db.role.create({ data: { id: roleId, name: `Wildcard fixture ${reader}`, permissions: ['*'] } });
    await db.userRole.create({ data: { userId: reader, roleId } });
    for (const [id, parentId] of [[orgRoot, null], [orgChild, orgRoot], [orgSibling, orgRoot]]) {
      await db.orgNode.create({ data: { id, name: id, parentId, path: parentId ? `${parentId}/${id}` : id } });
    }
    await db.userOrg.create({ data: { userId: reader, orgNodeId: orgChild } });
    for (const [id, type, orgNodeId] of [[privateKb, 'personal', null], [industryKb, 'industry', null], [orgKb, 'org', orgRoot], [siblingKb, 'org', orgSibling]]) {
      await db.knowledgeBase.create({ data: { id, type, orgNodeId, name: id, ownerUserId: owner, gitRepoUrl: 'test://application-acl' } });
    }
    assert.equal((await visible(reader)).includes(privateKb), false);
    assert.equal((await visible(admin)).includes(privateKb), false, 'system admin cannot read another personal library');
    assert.equal((await visible(reader)).includes(industryKb), false, 'wildcard role is not system admin');
    assert.equal((await visible(reader)).includes(orgKb), true, 'org membership inherits parent-library visibility');
    assert.equal((await visible(reader)).includes(siblingKb), false, 'sibling library remains invisible');
    const grant = await db.industryGrant.create({ data: { kbId: industryKb, subjectType: 'user', subjectId: reader, grantedById: owner } });
    assert.equal((await visible(reader)).includes(industryKb), true);
    await db.industryGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await visible(reader)).includes(industryKb), false, 'expired grants do not authorize');
    await db.industryGrant.update({ where: { id: grant.id }, data: { subjectType: 'role', subjectId: roleId, expiresAt: null } });
    assert.equal((await visible(reader)).includes(industryKb), true, 'role grants authorize');
    await db.industryGrant.update({ where: { id: grant.id }, data: { subjectType: 'org', subjectId: orgChild } });
    assert.equal((await visible(reader)).includes(industryKb), true, 'organization grants authorize');
    for (const [id, aclMode] of [[publicDoc, 'inherit'], [secretDoc, 'restricted']]) {
      await db.document.create({ data: { id, kbId: industryKb, title: id, mdPath: `${id}.md`, sourceType: 'upload', status: 'published', aclMode, contentHash: id } });
    }
    assert.deepEqual([...await readable(reader)], [publicDoc], 'empty restricted ACL denies');
    assert.equal((await readable(owner)).size, 2, 'owner retains access');
    await db.documentAcl.create({ data: { documentId: secretDoc, subjectType: 'user', subjectId: reader } });
    assert.equal((await readable(reader)).size, 2);
    const manifest = [publicDoc, secretDoc].map(documentId => ({ documentId, versionId: null, number: 1, sourceHash: documentId, effectiveTo: null }));
    assert.equal(await validateEvidenceDependenciesInClient(reader, manifest, db), true);
    await db.documentAcl.deleteMany({ where: { documentId: secretDoc } });
    assert.equal(await validateEvidenceDependenciesInClient(reader, manifest, db), false, 'every dependency must remain readable');
    await db.document.update({ where: { id: secretDoc }, data: { aclMode: 'inherit' } });
    for (const data of [{ contentHash: 'changed' }, { version: 2 }, { status: 'archived' },
      { effectiveFrom: new Date(Date.now() + 60000) }, { effectiveTo: new Date(Date.now() - 1000) }, { lifecycleStatus: 'repealed' }]) {
      await db.document.update({ where: { id: secretDoc }, data });
      assert.equal(await validateEvidenceDependenciesInClient(reader, manifest, db), false, `source drift denied: ${Object.keys(data)[0]}`);
      await db.document.update({ where: { id: secretDoc }, data: { contentHash: secretDoc, version: 1, status: 'published', effectiveFrom: null, effectiveTo: null, lifecycleStatus: 'active' } });
    }
    assert.equal(await validateEvidenceDependenciesInClient(reader, manifest, db), true);
    await db.industryGrant.delete({ where: { id: grant.id } });
    assert.equal(await validateEvidenceDependenciesInClient(reader, manifest, db), false, 'library revocation invalidates every source');
    assert.equal(await validateEvidenceDependenciesInClient(reader, null, db), false);
    console.log('Application ACL: personal isolation, org ancestry/sibling denial, role/org/expiry grants, restricted ACL, source conjunction/version/hash/time/revocation passed.');
  } finally {
    await db.knowledgeBase.deleteMany({ where: { id: { in: [privateKb, industryKb, orgKb, siblingKb] } } });
    await db.user.deleteMany({ where: { id: { in: [owner, reader, admin] } } });
    await db.orgNode.deleteMany({ where: { id: { in: [orgRoot, orgChild, orgSibling] } } });
    await db.role.deleteMany({ where: { id: { in: [roleId, ...(createdAdminRole ? [createdAdminRole] : [])] } } });
    await disconnectPrismaClient();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
