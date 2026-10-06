// Type-only: erased at compile time, so it cannot load the service before the
// database target above is chosen.
import type { UserCredentialService as UserCredentialServiceType } from './user-credential.service';

// Integration fixture: it exercises real credentials against a real database.
// A developer's default database can lag the migration history, so the target
// can be redirected to an isolated, fully migrated database with
// USER_CREDENTIAL_TEST_DATABASE_URL without touching the shared local one.
// RLS has been removed, so no runtime-role override is needed.
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousAppUrl = process.env.DATABASE_URL_APP;
if (process.env.USER_CREDENTIAL_TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.USER_CREDENTIAL_TEST_DATABASE_URL;
  delete process.env.DATABASE_URL_APP;
}
const { UserCredentialService } = require('./user-credential.service');
const { getPrismaClient } = require('../prisma');
const { runAsAuth } = require('../db/tenant-context.service');
const { randomUUID } = require('node:crypto');
const { runWithRequestContext } = require('../observability/request-context');

const SEEDED_USER = {
  id: 'b0090000-0000-4000-8000-000000000001',
  username: 'user_credential_fixture',
  displayName: 'User Credential Fixture',
  email: 'user-credential-fixture@example.invalid',
};

describe('UserCredentialService', () => {
  let service: UserCredentialServiceType;
  const prisma = getPrismaClient();
  let testUserId: string;
  let seededUserId: string | null = null;

  beforeAll(async () => {
    jest.setTimeout(20000);
    service = new UserCredentialService();
    // Own fixture only: never provision credentials on a developer's real user.
    const fixtureId = randomUUID();
    const user = await runAsAuth((tx: any) => tx.user.create({ data: {
      ...SEEDED_USER, id: fixtureId, username: `fixture_${fixtureId}`,
      email: `${fixtureId}@example.invalid`, status: 'active', source: 'manual',
    } }));
    seededUserId = user.id;
    testUserId = user.id;
  });

  afterAll(async () => {
    if (seededUserId) {
      await runAsAuth(async (tx: any) => {
        await tx.userCredential.deleteMany({ where: { userId: seededUserId } });
        await tx.user.deleteMany({ where: { id: seededUserId } });
      });
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousAppUrl === undefined) delete process.env.DATABASE_URL_APP;
    else process.env.DATABASE_URL_APP = previousAppUrl;
  });

  afterEach(async () => {
    // Clean up any test credentials
    if (testUserId) await runAsAuth((tx: any) => tx.userCredential.deleteMany({
      where: { userId: testUserId, name: { contains: 'UnitTest' } },
    }));
  });

  async function withFixtureUser(work: () => Promise<void>) {
    return work();
  }

  it('should auto-create default credential if user has none, and list credentials', async () => withFixtureUser(async () => {
    const list = await service.getCredentials(testUserId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].appId).toMatch(/^app_/);
    expect(list[0].maskedSecret).toMatch(/^sec_••••/);
  }));

  it('should add, update, rotate secret, and delete credential', async () => withFixtureUser(async () => {
    // 1. Add
    const created = await service.createCredential(testUserId, {
      appId: `app_unittest_${Date.now()}`,
      name: 'UnitTest External Integration',
    });
    expect(created.appId).toContain('app_unittest_');
    expect(created.appSecret).toMatch(/^sec_/);
    expect(created.status).toBe('active');

    // 2. Verify authentication
    const verified = await service.verifyCredential(created.appId, created.appSecret);
    expect(verified).not.toBeNull();
    expect(verified?.user.id).toBe(testUserId);

    // 3. Update (rename and toggle status)
    const updated = await service.updateCredential(testUserId, created.id, {
      name: 'UnitTest Renamed',
      status: 'disabled',
    });
    expect(updated.name).toBe('UnitTest Renamed');
    expect(updated.status).toBe('disabled');

    // Disabled credential should fail auth
    const verifyDisabled = await service.verifyCredential(created.appId, created.appSecret);
    expect(verifyDisabled).toBeNull();

    // Re-enable and rotate secret
    const rotated = await service.updateCredential(testUserId, created.id, {
      status: 'active',
      rotateSecret: true,
    });
    expect(rotated.status).toBe('active');
    expect(rotated.appSecret).toBeDefined();
    expect(rotated.appSecret).not.toBe(created.appSecret);

    // Old secret fails
    expect(await service.verifyCredential(created.appId, created.appSecret)).toBeNull();
    // New secret succeeds
    const verifyNew = await service.verifyCredential(created.appId, rotated.appSecret!);
    expect(verifyNew).not.toBeNull();

    // 4. Delete
    const deleteResult = await service.deleteCredential(testUserId, created.id);
    expect(deleteResult.success).toBe(true);

    // Should no longer exist
    expect(await service.verifyCredential(created.appId, rotated.appSecret!)).toBeNull();
  }));
});
