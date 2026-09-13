import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

type TokenPayload = { sub: string; exp: number };

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
    { expiresAt: number; active: boolean; mustChangePassword: boolean }
  >();

  invalidateUserStatus(userId: string): void {
    this.userStatusCache.delete(userId);
  }

  private async getUserStatus(
    userId: string,
  ): Promise<{ active: boolean; mustChangePassword: boolean }> {
    const ttl = AuthService.USER_STATUS_TTL_MS;
    const cached = this.userStatusCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, mustChangePassword: true },
    });
    const entry = {
      expiresAt: Date.now() + ttl,
      active: user?.status === 'active',
      mustChangePassword: Boolean(user?.mustChangePassword),
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

  async login(username: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username }, { email: username }], status: 'active' },
      include: { roles: { include: { role: true } }, orgs: { include: { orgNode: true } } },
    });
    if (!user?.passwordHash || !this.verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid username or password.');
    }
    const token = this.encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 });
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { token, expiresIn: 8 * 60 * 60, user: safeUser };
  }

  async userIdFromRequest(req: any): Promise<string> {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const payload = token ? this.decode(token) : null;
    if (!payload) throw new UnauthorizedException('A valid Bearer token is required.');
    const status = await this.getUserStatus(payload.sub);
    if (!status.active) throw new UnauthorizedException('User is inactive or does not exist.');
    return payload.sub;
  }

  async isPasswordChangeRequired(userId: string): Promise<boolean> {
    return (await this.getUserStatus(userId)).mustChangePassword;
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
      where: { userId, role: { OR: [{ name: '超级管理员' }, { name: '系统管理员' }, { builtin: true }] } },
      select: { userId: true },
    });
    if (!adminRole) throw new ForbiddenException('Administrator role required.');
    return userId;
  }
}
