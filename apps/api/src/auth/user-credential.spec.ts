import { UserCredentialService } from './user-credential.service';
import { getPrismaClient } from '../prisma';

describe('UserCredentialService', () => {
  let service: UserCredentialService;
  const prisma = getPrismaClient();
  let testUserId: string;

  beforeAll(async () => {
    jest.setTimeout(20000);
    service = new UserCredentialService();
    const user = await prisma.user.findFirst({ where: { status: 'active' } });
    if (!user) throw new Error('No active user found for tests');
    testUserId = user.id;
  });

  afterEach(async () => {
    // Clean up any test credentials
    await prisma.userCredential.deleteMany({
      where: {
        userId: testUserId,
        name: { contains: 'UnitTest' },
      },
    });
  });

  it('should auto-create default credential if user has none, and list credentials', async () => {
    const list = await service.getCredentials(testUserId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].appId).toMatch(/^app_/);
    expect(list[0].maskedSecret).toMatch(/^sec_••••/);
  });

  it('should add, update, rotate secret, and delete credential', async () => {
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
  });
});
