import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { setRequestContextUser } from '../observability/request-context';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type TokenPayload = { sub: string; exp: number; purpose?: 'mfa' };

const ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;
/** Short-lived second-factor ticket: enough to type a TOTP, useless as a session. */
const MFA_TOKEN_TTL_SECONDS = 300;
const MFA_POLICY_KEY = 'requireMfaForAdmins';
const ADMIN_ROLE_MATCH = {
  OR: [{ name: '超级管理员' }, { name: '系统管理员' }, { builtin: true }],
};

@Injectable()
export class AuthService {
  private readonly prisma = getPrismaClient();
  /**
   * 每个请求都会经由 AuthGuard + Controller 至少查询两次用户的存活/改密状态。
   * 用短 TTL 进程内缓存把高频路径上的这两次 DB 往返收敛为每用户每 TTL 一次；
   * 改密、禁用等状态变更入口负责主动失效，TTL 只兜底。
   */
  private static readonly USER_STATUS_TTL_MS = Math.max(
    0,
    Number(process.env.AUTH_USER_STATUS_TTL_MS ?? 30_000),
  );
  private readonly userStatusCache = new Map<
    string,
    { expiresAt: number; active: boolean; mustChangePassword: boolean; mfaEnabled: boolean }
  >();

  invalidateUserStatus(userId: string): void {
    this.userStatusCache.delete(userId);
  }

  private async getUserStatus(
    userId: string,
  ): Promise<{ active: boolean; mustChangePassword: boolean; mfaEnabled: boolean }> {
    const ttl = AuthService.USER_STATUS_TTL_MS;
    const cached = this.userStatusCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, mustChangePassword: true, mfaEnabled: true },
    });
    const entry = {
      expiresAt: Date.now() + ttl,
      active: user?.status === 'active',
      mustChangePassword: Boolean(user?.mustChangePassword),
      mfaEnabled: Boolean(user?.mfaEnabled),
    };
    if (ttl > 0) this.userStatusCache.set(userId, entry);
    return entry;
  }

  private secret(): string {
    const secret = process.env.AUTH_SECRET;
    if (!secret && process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException('AUTH_SECRET is not configured.');
    }
    return secret || 'llmwiki-local-development-secret';
  }

  hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
  }

  verifyPassword(password: string, encoded: string): boolean {
    const [, salt, expected] = encoded.split('$');
    if (!salt || !expected) return false;
    const actual = scryptSync(password, salt, 64);
    const expectedBuffer = Buffer.from(expected, 'hex');
    return expectedBuffer.length === actual.length && timingSafeEqual(actual, expectedBuffer);
  }

  private encode(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret()).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private decode(token: string): TokenPayload | null {
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;
    const expected = createHmac('sha256', this.secret()).update(body).digest('base64url');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
      return payload.sub && payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
    } catch {
      return null;
    }
  }

  issueAccessToken(userId: string): { token: string; expiresIn: number } {
    const token = this.encode({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    });
    return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  issueMfaToken(userId: string): { mfaToken: string; expiresIn: number } {
    const mfaToken = this.encode({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + MFA_TOKEN_TTL_SECONDS,
      purpose: 'mfa',
    });
    return { mfaToken, expiresIn: MFA_TOKEN_TTL_SECONDS };
  }

  /** Decode an mfa-purpose ticket. Access tokens are rejected here. */
  verifyMfaToken(mfaToken: string): string {
    const payload = this.decode(String(mfaToken || ''));
    if (!payload || payload.purpose !== 'mfa') {
      throw new UnauthorizedException('A valid mfaToken is required.');
    }
    return payload.sub;
  }

  decodeToken(token: string): TokenPayload | null {
    return this.decode(token);
  }

  async isMfaEnforcedForAdmins(): Promise<boolean> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: MFA_POLICY_KEY },
    });
    const raw = String(row?.value ?? '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  async setMfaEnforcedForAdmins(enabled: boolean): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key: MFA_POLICY_KEY },
      create: { key: MFA_POLICY_KEY, value: enabled ? 'true' : 'false' },
      update: { value: enabled ? 'true' : 'false' },
    });
  }

  private isPrivilegedRole(user: { roles?: { role: { name: string; builtin: boolean } }[] }): boolean {
    return Boolean(
      user.roles?.some(
        (entry) =>
          entry.role.name === '超级管理员' ||
          entry.role.name === '系统管理员' ||
          entry.role.builtin,
      ),
    );
  }

  /**
   * When `requireMfaForAdmins` is on, privileged accounts that have not bound
   * TOTP must complete MFA setup before receiving a session.
   */
  async isMfaSetupRequired(user: {
    id: string;
    mfaEnabled?: boolean;
    roles?: { role: { name: string; builtin: boolean } }[];
  }): Promise<boolean> {
    if (user.mfaEnabled) return false;
    if (!this.isPrivilegedRole(user)) return false;
    return this.isMfaEnforcedForAdmins();
  }

  /** Backstop for already-issued sessions after the admin MFA policy is turned on. */
  async isMfaEnforcementBlocking(userId: string, roles?: { role: { name: string; builtin: boolean } }[]): Promise<boolean> {
    const status = await this.getUserStatus(userId);
    if (status.mfaEnabled) return false;
    if (!(await this.isMfaEnforcedForAdmins())) return false;
    if (roles) return this.isPrivilegedRole({ roles });
    const count = await this.prisma.userRole.count({
      where: { userId, role: ADMIN_ROLE_MATCH },
    });
    return count > 0;
  }

  async login(username: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username }, { email: username }], status: 'active' },
      include: { roles: { include: { role: true } }, orgs: { include: { orgNode: true } } },
    });
    if (!user?.passwordHash || !this.verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid username or password.');
    }
    if (user.mfaEnabled) {
      const { mfaToken, expiresIn } = this.issueMfaToken(user.id);
      return { mfaRequired: true as const, mfaToken, expiresIn };
    }
    if (await this.isMfaSetupRequired(user)) {
      const { mfaToken, expiresIn } = this.issueMfaToken(user.id);
      return { mfaSetupRequired: true as const, mfaToken, expiresIn };
    }
    const { token, expiresIn } = this.issueAccessToken(user.id);
    const { passwordHash: _passwordHash, mfaSecret: _mfaSecret, ...safeUser } = user;
    return { token, expiresIn, user: safeUser };
  }

  async completeLogin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } }, orgs: { include: { orgNode: true } } },
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('User is inactive or does not exist.');
    }
    const { token, expiresIn } = this.issueAccessToken(user.id);
    const { passwordHash: _passwordHash, mfaSecret: _mfaSecret, ...safeUser } = user;
    return { token, expiresIn, user: safeUser };
  }

  async userIdFromRequest(req: any): Promise<string> {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const payload = token ? this.decode(token) : null;
    // mfa-purpose tickets must never be accepted as sessions.
    if (!payload || payload.purpose === 'mfa') throw new UnauthorizedException('A valid Bearer token is required.');
    const status = await this.getUserStatus(payload.sub);
    if (!status.active) throw new UnauthorizedException('User is inactive or does not exist.');
    setRequestContextUser(payload.sub);
    return payload.sub;
  }

  async isPasswordChangeRequired(userId: string): Promise<boolean> {
    return (await this.getUserStatus(userId)).mustChangePassword;
  }

  async isMfaEnabled(userId: string): Promise<boolean> {
    return (await this.getUserStatus(userId)).mfaEnabled;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (newPassword.length < 6) {
      throw new BadRequestException('New password must contain at least 6 characters.');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('New password must be different from the current password.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user?.passwordHash || !this.verifyPassword(currentPassword, user.passwordHash)) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: this.hashPassword(newPassword), mustChangePassword: false },
    });
    this.invalidateUserStatus(userId);
    return { ok: true };
  }

  async adminUserIdFromRequest(req: any): Promise<string> {
    const userId = await this.userIdFromRequest(req);
    const adminRole = await this.prisma.userRole.findFirst({
      where: { userId, role: ADMIN_ROLE_MATCH },
      select: { userId: true },
    });
    if (!adminRole) throw new ForbiddenException('Administrator role required.');
    return userId;
  }
}
