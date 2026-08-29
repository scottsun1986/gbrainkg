import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

type TokenPayload = { sub: string; exp: number };

@Injectable()
export class AuthService {
  private readonly prisma = new PrismaClient();

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
    const user = await this.prisma.user.findFirst({ where: { id: payload.sub, status: 'active' }, select: { id: true } });
    if (!user) throw new UnauthorizedException('User is inactive or does not exist.');
    return user.id;
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
