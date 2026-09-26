import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { getPrismaClient } from '../prisma';
import { base32Decode, totpNow, generateTotpSecret } from './totp';

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
    oidcSub: null as string | null,
    createdAt: new Date(),
    roles: [] as any[],
    orgs: [] as any[],
  });

  let userState: ReturnType<typeof baseUser>;

  beforeEach(() => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'llmwiki-unittest-secret';
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
      expect(userState.mfaSecret).toBe(setup.secret);
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
      userState.roles = [{ role: { name: '超级管理员', builtin: false } }] as any;
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
