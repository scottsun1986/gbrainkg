import { OpenApiGuard } from './open-api.guard';

const mockPrisma = { user: { findUnique: jest.fn() } };
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('OpenAPI credential request boundary', () => {
  const credentials = { verifyCredential: jest.fn() };
  const auth = { userIdFromRequest: jest.fn(), isPasswordChangeRequired: jest.fn() };
  const rate = { check: jest.fn(), limitPerMinute: 120 };
  const response = { setHeader: jest.fn() };
  const context = () => ({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => response }) });
  let req: any;
  let guard: OpenApiGuard;
  beforeEach(() => {
    jest.clearAllMocks();
    req = { headers: { 'x-app-id': 'app', 'x-app-secret': 'secret' } };
    credentials.verifyCredential.mockResolvedValue({ user: { id: 'owner' }, credential: { id: 'credential', appId: 'app' } });
    rate.check.mockReturnValue({ allowed: true });
    guard = new OpenApiGuard(credentials as any, auth as any, rate as any);
  });
  it('revalidates each credential request and rejects revoked credentials before rate or endpoint work', async () => {
    await expect(guard.canActivate(context() as any)).resolves.toBe(true);
    expect(req.user.id).toBe('owner');
    credentials.verifyCredential.mockResolvedValue(null);
    await expect(guard.canActivate(context() as any)).rejects.toThrow();
    expect(credentials.verifyCredential).toHaveBeenCalledTimes(2);
    expect(rate.check).toHaveBeenCalledTimes(1);
  });
  it('sets Retry-After and stops an authenticated over-limit request', async () => {
    rate.check.mockReturnValue({ allowed: false, retryAfterSec: 12 });
    await expect(guard.canActivate(context() as any)).rejects.toMatchObject({ status: 429 });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '12');
  });
  it('only accepts bearer users that are active and have completed password change', async () => {
    req.headers = { authorization: 'Bearer token' };
    auth.userIdFromRequest.mockResolvedValue('owner');
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'owner', roles: [], orgs: [] });
    auth.isPasswordChangeRequired.mockResolvedValue(true);
    await expect(guard.canActivate(context() as any)).rejects.toThrow();
    auth.isPasswordChangeRequired.mockResolvedValue(false);
    await expect(guard.canActivate(context() as any)).resolves.toBe(true);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'owner', status: 'active' } }));
    expect(credentials.verifyCredential).not.toHaveBeenCalled();
  });
});
