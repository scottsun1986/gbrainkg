import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { AuthService } from './auth.service';
import {
  base32Decode,
  buildOtpauthUri,
  generateTotpSecret,
  verifyTotp,
} from './totp';

export interface MfaSetupResult {
  secret: string;
  otpauthUri: string;
  issuer: string;
  account: string;
  digits: number;
  period: number;
  mfaEnabled: boolean;
}

@Injectable()
export class MfaService {
  private readonly prisma = getPrismaClient();

  constructor(private readonly authService: AuthService) {}

  private issuer(): string {
    return process.env.MFA_ISSUER?.trim() || process.env.OIDC_ISSUER?.trim() || 'GBrainKG';
  }

  /**
   * Authenticated caller identity. Accepts either a normal Bearer session or a
   * short-lived mfaToken issued after a password (or SSO) step — the latter is
   * what the forced-setup and second-factor login flows use.
   */
  async resolveActor(req: any, body?: { mfaToken?: string }): Promise<{ userId: string; fromMfaToken: boolean }> {
    const authorization = String(req?.headers?.authorization || '');
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (bearer) {
      const userId = await this.authService.userIdFromRequest(req);
      return { userId, fromMfaToken: false };
    }
    const mfaToken = String(body?.mfaToken || '');
    if (!mfaToken) {
      throw new UnauthorizedException('Authentication required (Bearer token or mfaToken).');
    }
    const userId = this.authService.verifyMfaToken(mfaToken);
    return { userId, fromMfaToken: true };
  }

  async getMfaStatus(userId: string): Promise<{ mfaEnabled: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaEnabled: true },
    });
    return { mfaEnabled: Boolean(user?.mfaEnabled) };
  }

  /** Generate a fresh TOTP secret and return the otpauth:// URI. Not active until verify(). */
  async setup(userId: string): Promise<MfaSetupResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, mfaEnabled: true },
    });
    if (!user) throw new UnauthorizedException('User is inactive or does not exist.');
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled. Disable it before re-enrolling.');
    }
    const { base32 } = generateTotpSecret();
    const issuer = this.issuer();
    const account = user.email || user.username;
    const otpauthUri = buildOtpauthUri({
      secretBase32: base32,
      account,
      issuer,
      digits: 6,
      period: 30,
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: base32, mfaEnabled: false, mfaEnabledAt: null },
    });
    this.authService.invalidateUserStatus(userId);
    return {
      secret: base32,
      otpauthUri,
      issuer,
      account,
      digits: 6,
      period: 30,
      mfaEnabled: false,
    };
  }

  /**
   * Confirm a pending enrolment. When called with an mfaToken (forced admin
   * setup / post-SSO MFA) the successful verify completes the login and returns
   * a real session token.
   */
  async verify(
    userId: string,
    code: string,
    options: { fromMfaToken?: boolean } = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, mfaSecret: true, mfaEnabled: true, status: true },
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('User is inactive or does not exist.');
    }
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled.');
    }
    if (!user.mfaSecret) {
      throw new BadRequestException('MFA setup has not been started. Call /auth/mfa/setup first.');
    }
    if (!verifyTotp(base32Decode(user.mfaSecret), code)) {
      throw new UnauthorizedException('Invalid TOTP code.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaEnabledAt: new Date() },
    });
    this.authService.invalidateUserStatus(userId);
    if (options.fromMfaToken) {
      return this.authService.completeLogin(userId);
    }
    return { ok: true, mfaEnabled: true };
  }

  /** Disable MFA. Requires the account password OR a currently valid TOTP code. */
  async disable(userId: string, password?: string, code?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, mfaSecret: true, mfaEnabled: true },
    });
    if (!user) throw new UnauthorizedException('User is inactive or does not exist.');
    if (!user.mfaEnabled) {
      throw new BadRequestException('MFA is not enabled for this account.');
    }
    const passwordOk = Boolean(
      password && user.passwordHash && this.authService.verifyPassword(password, user.passwordHash),
    );
    const codeOk = Boolean(
      code && user.mfaSecret && verifyTotp(base32Decode(user.mfaSecret), code),
    );
    if (!passwordOk && !codeOk) {
      throw new UnauthorizedException(
        'A valid password or TOTP code is required to disable MFA.',
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaEnabled: false, mfaEnabledAt: null },
    });
    this.authService.invalidateUserStatus(userId);
    return { ok: true, mfaEnabled: false };
  }

  /** Second step of password login (or post-SSO MFA): mfaToken + TOTP → session. */
  async login(mfaToken: string, code: string) {
    const userId = this.authService.verifyMfaToken(mfaToken);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, mfaEnabled: true, mfaSecret: true },
    });
    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecret) {
      throw new UnauthorizedException('MFA is not available for this account.');
    }
    if (!verifyTotp(base32Decode(user.mfaSecret), code)) {
      throw new UnauthorizedException('Invalid TOTP code.');
    }
    return this.authService.completeLogin(userId);
  }
}
