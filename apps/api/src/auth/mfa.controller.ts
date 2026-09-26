import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from './auth.guard';
import { MfaService } from './mfa.service';
import { AuditService } from '../audit/audit.service';

@Controller('api/v1/auth/mfa')
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly auditService: AuditService,
  ) {}

  /** Current user's MFA state. Works with a session or an mfaToken. */
  @Get('status')
  async status(@Req() req: any) {
    const { userId } = await this.mfaService.resolveActor(req, { mfaToken: String(req.query?.mfaToken || '') });
    return this.mfaService.getMfaStatus(userId);
  }

  /** Start TOTP enrolment: returns otpauth:// URI + raw secret (base32). */
  @Post('setup')
  async setup(@Req() req: any, @Body() body: { mfaToken?: string }) {
    const { userId } = await this.mfaService.resolveActor(req, body);
    const result = await this.mfaService.setup(userId);
    this.auditService
      .log({ userId, action: 'mfa.setup', resource: 'auth', details: { issuer: result.issuer } })
      .catch(() => undefined);
    return result;
  }

  /** Confirm enrolment with a TOTP code. mfaToken callers get a session back. */
  @Throttle({
    default: {
      limit: Number(process.env.AUTH_LOGIN_THROTTLE_LIMIT || 10),
      ttl: 60000,
    },
  })
  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: any, @Body() body: { code?: string; mfaToken?: string }) {
    const { userId, fromMfaToken } = await this.mfaService.resolveActor(req, body);
    try {
      const result = await this.mfaService.verify(userId, String(body?.code || ''), { fromMfaToken });
      this.auditService
        .log({ userId, action: 'mfa.verify', resource: 'auth', details: { fromMfaToken } })
        .catch(() => undefined);
      return result;
    } catch (error) {
      this.auditService
        .log({ userId, action: 'mfa.verify_failed', resource: 'auth' })
        .catch(() => undefined);
      throw error;
    }
  }

  /** Turn MFA off. Requires password or a valid TOTP code. */
  @UseGuards(AuthGuard)
  @Post('disable')
  @HttpCode(200)
  async disable(
    @Req() req: any,
    @Body() body: { password?: string; code?: string },
  ) {
    const { userId } = await this.mfaService.resolveActor(req);
    const result = await this.mfaService.disable(
      userId,
      String(body?.password || ''),
      String(body?.code || ''),
    );
    this.auditService
      .log({ userId, action: 'mfa.disable', resource: 'auth' })
      .catch(() => undefined);
    return result;
  }

  /** Second step of login: mfaToken + TOTP → { token, expiresIn, user }. */
  @Throttle({
    default: {
      limit: Number(process.env.AUTH_LOGIN_THROTTLE_LIMIT || 10),
      ttl: 60000,
    },
  })
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { mfaToken?: string; code?: string }) {
    try {
      const result = await this.mfaService.login(
        String(body?.mfaToken || ''),
        String(body?.code || ''),
      );
      this.auditService
        .log({
          userId: result.user.id,
          action: 'mfa_login',
          resource: 'auth',
        })
        .catch(() => undefined);
      return result;
    } catch (error) {
      this.auditService
        .log({ userId: 'unknown', action: 'mfa_login_failed', resource: 'auth' })
        .catch(() => undefined);
      throw error;
    }
  }
}
