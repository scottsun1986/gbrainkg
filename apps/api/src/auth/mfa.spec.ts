import { decryptModelCredential } from '../model-credential';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { getPrismaClient } from '../prisma';
import { base32Decode, totpNow, generateTotpSecret } from './totp';
// The authentication reads now run through the runAsAuth transaction client.
// Hand the callback the same mocked client the specs spy on so those spies
// (prisma.user.findFirst etc.) still intercept.
jest.mock('../db/tenant-context.service', () => ({
  runAsAuth: async (work: any) => work(require('../prisma').getPrismaClient()),
}));

const prisma = getPrismaClient();

describe('MFA/TOTP two-step login', () => {
  let authService: AuthService;
  let mfaService: MfaService;
  const userId = '11111111-1111-4111-8111-111111111111';
  const password = 'correct-horse-battery';
  const secret = generateTotpSecret();

  const baseUser = () => ({
    id: userId,
    username: 'alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    passwordHash: new AuthService().hashPassword(password),
    mustChangePassword: false,
    status: 'active',
    source: 'manual',
    mfaSecret: null as string | null,
    mfaEnabled: false,
    mfaEnabledAt: null as Date | null,
    mfaLastCounter: null as number | null,
    oidcSub: null as string | null,
    createdAt: new Date(),
    roles: [] as any[],
    orgs: [] as any[],
  });

  let userState: ReturnType<typeof baseUser>;

  beforeEach(() => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'llmwiki-unittest-secret-0123456789';
    authService = new AuthService();
    mfaService = new MfaService(authService);
    userState = baseUser();
    jest.spyOn(prisma.user, 'findFirst').mockImplementation((async (args: any) => {
      if (args?.where?.status !== 'active') return null;
      return { ...userState } as any;
    }) as any);
    jest.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.id === userId) return { ...userState } as any;
      return null;
    }) as any);
    jest.spyOn(prisma.user, 'updateMany').mockImplementation((async (args: any) => {
      if (Object.entries(args.where).some(([key, value]) => key !== 'OR' && (userState as any)[key] !== value)) return { count: 0 };
      if (args.where.OR && userState.mfaLastCounter !== null && !args.where.OR.some((part: any) => part.mfaLastCounter?.lt > userState.mfaLastCounter!)) return { count: 0 };
      userState = { ...userState, ...args.data };
      return { count: 1 };
    }) as any);
    jest.spyOn(prisma.user, 'update').mockImplementation((async (args: any) => {
      userState = { ...userState, ...(args.data as any) };
      return { ...userState } as any;
    }) as any);
    (prisma as any).systemSetting = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ key: 'requireMfaForAdmins', value: 'false' }),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('password login without MFA still returns a session token directly', async () => {
    const result: any = await authService.login('alice', password);
    expect(result.mfaRequired).toBeUndefined();
    expect(result.token).toBeTruthy();
    expect(result.expiresIn).toBe(8 * 60 * 60);
    expect(result.user.passwordHash).toBeUndefined();
    expect(result.user.mfaSecret).toBeUndefined();
  });

  it('rejects a bad password even before MFA', async () => {
    await expect(authService.login('alice', 'wrong')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a malformed Unicode token signature without throwing', () => {
    expect(authService.decodeToken(`body.${'é'.repeat(43)}`)).toBeNull();
    expect(authService.decodeToken(`${authService.issueAccessToken(userId).token}.extra`)).toBeNull();
  });

  it('does not enable a secret replaced during verification', async () => {
    userState.mfaSecret = secret.base32;
    jest.spyOn(prisma.user, 'updateMany').mockResolvedValueOnce({ count: 0 });
    await expect(mfaService.verify(userId, totpNow(secret.raw), { fromMfaToken: true }))
      .rejects.toThrow('MFA state changed');
    expect(userState.mfaEnabled).toBe(false);
  });

  it('does not reset MFA enabled by a concurrent request', async () => {
    jest.spyOn(prisma.user, 'updateMany').mockResolvedValueOnce({ count: 0 });
    await expect(mfaService.setup(userId)).rejects.toThrow('MFA state changed');
  });

  describe('with mfaEnabled', () => {
    beforeEach(() => {
      userState.mfaSecret = secret.base32;
      userState.mfaEnabled = true;
    });

    it('step 1: correct password returns { mfaRequired, mfaToken } and NO session token', async () => {
      const result: any = await authService.login('alice', password);
      expect(result.mfaRequired).toBe(true);
      expect(result.mfaToken).toBeTruthy();
      expect(result.token).toBeUndefined();
    });

    it('mfaToken is rejected as a Bearer session token', async () => {
      const result: any = await authService.login('alice', password);
      await expect(
        authService.userIdFromRequest({
          headers: { authorization: `Bearer ${result.mfaToken}` },
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('step 2: wrong TOTP code is rejected', async () => {
      const result: any = await authService.login('alice', password);
      await expect(mfaService.login(result.mfaToken, '000000')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('step 2: valid TOTP exchanges mfaToken for a real session', async () => {
      const result: any = await authService.login('alice', password);
      const code = totpNow(secret.raw);
      const session: any = await mfaService.login(result.mfaToken, code);
      expect(session.token).toBeTruthy();
      expect(session.expiresIn).toBe(8 * 60 * 60);
      expect(session.user.id).toBe(userId);
      expect(session.user.passwordHash).toBeUndefined();
      expect(session.user.mfaSecret).toBeUndefined();

      const resolved = await authService.userIdFromRequest({
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(resolved).toBe(userId);
    });

    it('accepts a TOTP counter once across concurrent login attempts', async () => {
      const { mfaToken: token } = authService.issueMfaToken(userId);
      const results = await Promise.allSettled([mfaService.login(token, totpNow(secret.raw)), mfaService.login(token, totpNow(secret.raw))]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    });

    it('step 2: a session token cannot be replayed as an mfaToken', async () => {
      const session = authService.issueAccessToken(userId);
      await expect(mfaService.login(session.token, totpNow(secret.raw))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('disable requires password or a valid TOTP code', async () => {
      await expect(mfaService.disable(userId)).rejects.toThrow(UnauthorizedException);
      await expect(mfaService.disable(userId, 'wrong-password', '000000')).rejects.toThrow(
        UnauthorizedException,
      );
      const ok = await mfaService.disable(userId, password, '');
      expect(ok).toEqual({ ok: true, mfaEnabled: false });
      expect(userState.mfaEnabled).toBe(false);
      expect(userState.mfaSecret).toBeNull();
    });

    it('disable accepts a valid TOTP instead of the password', async () => {
      const code = totpNow(secret.raw);
      const ok = await mfaService.disable(userId, '', code);
      expect(ok).toEqual({ ok: true, mfaEnabled: false });
    });
  });

  describe('setup / verify enrolment', () => {
    it('setup stores a pending secret but does not enable MFA', async () => {
      const setup = await mfaService.setup(userId);
      expect(setup.secret).toBeTruthy();
      expect(setup.otpauthUri).toContain('otpauth://totp/');
      expect(setup.mfaEnabled).toBe(false);
      expect(userState.mfaEnabled).toBe(false);
      // The seed is stored as an encrypted envelope, never as plaintext.
      expect(userState.mfaSecret).not.toBe(setup.secret);
      expect(userState.mfaSecret).toMatch(/^enc:v1:/);
      expect(decryptModelCredential(Buffer.from(userState.mfaSecret ?? '', 'utf8'))).toBe(setup.secret);
    });

    it('verify with a bad code does not enable MFA', async () => {
      await mfaService.setup(userId);
      await expect(mfaService.verify(userId, '000000')).rejects.toThrow(UnauthorizedException);
      expect(userState.mfaEnabled).toBe(false);
    });

    it('verify with the current TOTP enables MFA', async () => {
      const setup = await mfaService.setup(userId);
      const code = totpNow(base32Decode(setup.secret));
      const result = await mfaService.verify(userId, code);
      expect(result).toEqual({ ok: true, mfaEnabled: true });
      expect(userState.mfaEnabled).toBe(true);
    });

    it('verify via mfaToken (forced admin setup) completes the login with a session', async () => {
      userState.mfaSecret = secret.base32;
      userState.mfaEnabled = false;
      const code = totpNow(secret.raw);
      const session: any = await mfaService.verify(userId, code, { fromMfaToken: true });
      expect(session.token).toBeTruthy();
      expect(session.user.id).toBe(userId);
      expect(userState.mfaEnabled).toBe(true);
    });

    it('setup is refused once MFA is already enabled', async () => {
      userState.mfaEnabled = true;
      userState.mfaSecret = secret.base32;
      await expect(mfaService.setup(userId)).rejects.toThrow(BadRequestException);
    });
  });

  describe('requireMfaForAdmins', () => {
    it('admin without MFA is forced into setup instead of receiving a token', async () => {
      userState.roles = [{ role: { name: 'renamed display label', code: 'super_admin', builtin: false } }] as any;
      (prisma as any).systemSetting.findUnique = jest
        .fn()
        .mockResolvedValue({ key: 'requireMfaForAdmins', value: 'true' });
      const result: any = await authService.login('alice', password);
      expect(result.mfaSetupRequired).toBe(true);
      expect(result.mfaToken).toBeTruthy();
      expect(result.token).toBeUndefined();
    });

    it('non-admin users are unaffected by requireMfaForAdmins', async () => {
      userState.roles = [{ role: { name: '普通用户', builtin: false } }] as any;
      (prisma as any).systemSetting.findUnique = jest
        .fn()
        .mockResolvedValue({ key: 'requireMfaForAdmins', value: 'true' });
      const result: any = await authService.login('alice', password);
      expect(result.token).toBeTruthy();
      expect(result.mfaSetupRequired).toBeUndefined();
    });
  });
});

const totpCounterOf = (key: Buffer): number => Math.floor(Date.now() / 1000 / 30);

describe('MFA secret storage hardening', () => {
  const hardenedUserId = '22222222-2222-4222-8222-222222222222';
  const password = 'correct-horse-battery';
  let mfaService: MfaService;
  let userState: any;

  const baseUser = () => ({
    id: hardenedUserId, username: 'bob', displayName: 'Bob', email: 'bob@example.com',
    passwordHash: new AuthService().hashPassword(password),
    mustChangePassword: false, status: 'active', source: 'manual',
    mfaSecret: null as string | null, mfaEnabled: false, mfaEnabledAt: null as Date | null,
    mfaLastCounter: null as number | null, oidcSub: null as string | null,
    createdAt: new Date(), roles: [] as any[], orgs: [] as any[],
  });

  beforeEach(() => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'llmwiki-unittest-secret-0123456789';
    jest.restoreAllMocks();
    const auth = new AuthService();
    jest.spyOn(auth, 'invalidateUserStatus').mockImplementation(() => undefined);
    mfaService = new MfaService(auth as any);
    jest.spyOn(prisma.user, 'findFirst').mockImplementation((async (args: any) => {
      if (args?.where?.status !== 'active') return null;
      return { ...userState } as any;
    }) as any);
    jest.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.id === hardenedUserId) return { ...userState } as any;
      return null;
    }) as any);
    jest.spyOn(prisma.user, 'updateMany').mockImplementation((async (args: any) => {
      if (Object.entries(args.where).some(([key, value]) => key !== 'OR' && (userState as any)[key] !== value)) return { count: 0 };
      if (args.where.OR && userState.mfaLastCounter !== null && !args.where.OR.some((part: any) => part.mfaLastCounter?.lt > userState.mfaLastCounter!)) return { count: 0 };
      userState = { ...userState, ...args.data };
      return { count: 1 };
    }) as any);
    mfaService = new MfaService(auth as any);
    userState = baseUser();
  });

  it('never persists the TOTP seed in plaintext', async () => {
    const setup = await mfaService.setup(hardenedUserId);
    expect(userState.mfaSecret).not.toBe(setup.secret);
    expect(userState.mfaSecret).toMatch(/^enc:v1:/);
    expect(decryptModelCredential(Buffer.from(userState.mfaSecret, 'utf8'))).toBe(setup.secret);
  });

  it('still verifies enrolment and login against the encrypted seed', async () => {
    const setup = await mfaService.setup(hardenedUserId);
    await expect(mfaService.verify(hardenedUserId, totpNow(base32Decode(setup.secret)))).resolves.toEqual({ ok: true, mfaEnabled: true });
  });

  it('lets the owner disable MFA with the account password alone', async () => {
    const setup = await mfaService.setup(hardenedUserId);
    await mfaService.verify(hardenedUserId, totpNow(base32Decode(setup.secret)));
    await expect(mfaService.disable(hardenedUserId, password, '')).resolves.toEqual({ ok: true, mfaEnabled: false });
    expect(userState.mfaSecret).toBeNull();
    expect(userState.mfaEnabled).toBe(false);
  });

  it('does not let a consumed TOTP code block password-based recovery', async () => {
    const setup = await mfaService.setup(hardenedUserId);
    await mfaService.verify(hardenedUserId, totpNow(base32Decode(setup.secret)));
    // Enrolment consumed this counter, so replaying the same code fails...
    userState.mfaLastCounter = totpCounterOf(base32Decode(setup.secret));
    await expect(mfaService.disable(hardenedUserId, '', totpNow(base32Decode(setup.secret)))).rejects.toThrow(/already used/);
    // ...so the password path must remain available, or the account is stuck.
    await expect(mfaService.disable(hardenedUserId, password, '')).resolves.toMatchObject({ mfaEnabled: false });
  });
});
