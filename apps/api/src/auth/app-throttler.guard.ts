import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Global rate limiter with a login-only bypass for controlled environments.
 *
 * Login is throttled to `AUTH_LOGIN_THROTTLE_LIMIT` (default 10/min) to blunt
 * credential-stuffing. E2E / benchmark orchestration legitimately logs in many
 * times in one run and was hitting HTTP 429, aborting the run. The fix the audit
 * asked for is an explicit whitelist rather than raising the production limit:
 *
 *   AUTH_LOGIN_THROTTLE_BYPASS_IPS=127.0.0.1,10.0.0.5   # per-source-IP list
 *   AUTH_LOGIN_THROTTLE_BYPASS=1                        # bypass every source
 *
 * Both are honoured **only** for the login endpoint. The master switch is an
 * explicit operator opt-in that works regardless of NODE_ENV (the shared test
 * box runs NODE_ENV=production but is not the real deployment); the per-IP list
 * is limited to non-production so it can never weaken a real deployment. No
 * other route is affected.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (await super.shouldSkip(context)) return true;
    return this.isLoginThrottleBypassed(context);
  }

  private isLoginThrottleBypassed(context: ExecutionContext): boolean {
    const bypassAll =
      String(process.env.AUTH_LOGIN_THROTTLE_BYPASS || '').toLowerCase() === '1';
    const bypassIps = String(process.env.AUTH_LOGIN_THROTTLE_BYPASS_IPS || '');
    if (!bypassAll && !bypassIps.trim()) return false;

    const req: any = context.switchToHttp?.()?.getRequest?.();
    if (!req) return false;
    const path = String(req.originalUrl || req.url || '');
    // Only the login endpoint; a trailing slash or query string still matches.
    if (!/\/auth\/login(?:[/?]|$)/.test(path)) return false;

    // The master switch is a deliberate operator opt-in and works regardless of
    // NODE_ENV (the shared test box runs NODE_ENV=production but is not the real
    // production deployment). The per-IP list is a softer convenience and stays
    // limited to non-production so it can never weaken a real deployment.
    if (bypassAll) return true;
    if (process.env.NODE_ENV === 'production') return false;

    const ip = String(req.ip || req.socket?.remoteAddress || '');
    const normalized = ip.replace(/^::ffff:/, '');
    const allowed = new Set(
      bypassIps
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^::ffff:/, '')),
    );
    return allowed.has(normalized) || (LOOPBACK_IPS.has(ip) && allowed.has('loopback'));
  }
}
