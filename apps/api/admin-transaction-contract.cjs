// Dedicated disposable PostgreSQL audit database only. Uses the real controller.
process.env.DATABASE_URL = 'postgresql://postgres:audit-only-not-production@127.0.0.1:55439/postgres';
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { AdminController } = require('./src/admin.controller');

async function main() {
  const db = new PrismaClient();
  let dispatched = 0;
  const controller = new AdminController(
    { canManageUser: async () => true }, { userIdFromRequest: async () => 'audit-admin' },
    { queueAccessReconciliation: async () => {} }, {}, { dispatchPending: async () => { dispatched++; } },
  );
  const original = controller.prisma;
  controller.prisma = db;
  const id = randomUUID();
  try {
    await db.user.create({ data: { id, username: `audit-${id}`, email: `${id}@invalid.test`, displayName: 'audit', status: 'active' } });
    await db.$executeRawUnsafe(`CREATE FUNCTION audit_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit event write failure'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER audit_reject_event BEFORE INSERT ON "BrainChangeEvent" FOR EACH ROW EXECUTE FUNCTION audit_reject_event()`);
    await assert.rejects(controller.disableUser({}, id), /audit event write failure/);
    assert.equal((await db.user.findUnique({ where: { id } })).status, 'active');
    assert.equal(await db.brainChangeEvent.count({ where: { resourceId: id } }), 0);
    assert.equal(dispatched, 0);
    await db.$executeRawUnsafe('DROP TRIGGER audit_reject_event ON "BrainChangeEvent"');
    await controller.disableUser({}, id);
    assert.equal((await db.user.findUnique({ where: { id } })).status, 'disabled');
    assert.equal(await db.brainChangeEvent.count({ where: { resourceId: id, status: 'pending' } }), 1);
    assert.equal(dispatched, 1);
    console.log('PASS real PostgreSQL: event failure rolls back user mutation; success commits mutation and event together');
  } finally {
    await db.$disconnect();
    await original.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
