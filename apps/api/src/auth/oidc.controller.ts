import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OidcService } from './oidc.service';
import { AuditService } from '../audit/audit.service';

const OIDC_STATE_COOKIE = 'llmwiki_oidc_state';

/** Minimal cookie reader (cookie-parser is intentionally not a dependency). */
function readCookie(req: Request, name: string): string | undefined {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return undefined;
}

@Controller('api/v1/auth')
export class OidcController {
  constructor(
    private readonly oidcService: OidcService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Public auth capability probe so the login screen can decide whether to
   * render the SSO button. Never leaks client secrets.
   */
  @Get('config')
  config() {
    return {
      oidcEnabled: this.oidcService.isConfigured(),
      passwordLoginEnabled: true,
    };
  }

  /** Start of the authorization-code flow: 302 to the identity provider. */
  @Get('oidc/login')
  async login(@Res() res: Response) {
    if (!this.oidcService.isConfigured()) {
      throw new NotFoundException(
        'OIDC SSO is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI to enable it. Password login remains available.',
      );
    }
    const { url, state } = await this.oidcService.buildAuthorizationUrl();
    const secure = url.startsWith('https://');
    res.cookie(OIDC_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 600_000,
    });
    res.redirect(302, url);
  }

  /** Authorization-code callback: code → token → identity → local session. */
  @Get('oidc/callback')
  @HttpCode(302)
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    const landing = this.oidcService.postLoginRedirect();
    const fail = (message: string) => {
      const target = new URL(landing, 'http://localhost');
      target.hash = `sso_error=${encodeURIComponent(message)}`;
      res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });
      res.redirect(302, target.toString());
    };

    if (error) {
      this.auditService
        .log({
          userId: 'anonymous',
          action: 'oidc_login_failed',
          resource: 'auth',
          details: { error, errorDescription },
        })
        .catch(() => undefined);
      return fail(String(errorDescription || error));
    }
    if (!this.oidcService.isConfigured()) {
      return fail('OIDC SSO is not configured on this deployment.');
    }

    const cookieState = readCookie(req, OIDC_STATE_COOKIE);
    try {
      const result = await this.oidcService.handleCallback(String(code || ''), String(state || ''), {
        cookieState,
      });
      res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });
      const target = new URL(landing, 'http://localhost');
      if (result.kind === 'token') {
        this.auditService
          .log({
            userId: String((result.user as any)?.id || 'unknown'),
            action: 'oidc_login',
            resource: 'auth',
            details: { method: 'oidc' },
          })
          .catch(() => undefined);
        target.hash = `token=${encodeURIComponent(result.token)}`;
      } else if (result.kind === 'mfa') {
        target.hash = `mfa_token=${encodeURIComponent(result.mfaToken)}`;
      } else {
        target.hash = `mfa_setup_token=${encodeURIComponent(result.mfaToken)}`;
      }
      return res.redirect(302, target.toString());
    } catch (err) {
      this.auditService
        .log({
          userId: 'anonymous',
          action: 'oidc_login_failed',
          resource: 'auth',
          details: { reason: String(err) },
        })
        .catch(() => undefined);
      return fail(err instanceof Error ? err.message : 'SSO login failed.');
    }
  }
}
