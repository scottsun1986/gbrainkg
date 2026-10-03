/**
 * OIDC authorization-code SSO. Built on Node's built-in `fetch` and `node:crypto`
 * only (no new npm dependencies). Verify the `id_token` whenever present;
 * identity comes from userinfo, with verified token claims as a fallback.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { AuthService } from './auth.service';
import { authSigningSecret } from './auth-secret';

export interface OidcEnvConfig {
  configured: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
}

export interface OidcProviderEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}

export interface OidcIdentity {
  sub: string;
  email: string;
  username: string;
  displayName: string;
  raw: Record<string, unknown>;
}

export type OidcCallbackResult =
  | { kind: 'token'; token: string; expiresIn: number; user: Record<string, unknown> }
  | { kind: 'mfa'; mfaToken: string; expiresIn: number }
  | { kind: 'mfaSetup'; mfaToken: string; expiresIn: number };

const STATE_TTL_SECONDS = 600;

export function readOidcEnvConfig(): OidcEnvConfig {
  const issuer = String(process.env.OIDC_ISSUER || '').trim().replace(/\/$/, '');
  const clientId = String(process.env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.OIDC_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.OIDC_REDIRECT_URI || '').trim();
  const scopes = String(process.env.OIDC_SCOPES || '').trim() || 'openid email profile';
  const authorizationEndpoint = String(process.env.OIDC_AUTHORIZATION_ENDPOINT || '').trim();
  const tokenEndpoint = String(process.env.OIDC_TOKEN_ENDPOINT || '').trim();
  const userinfoEndpoint = String(process.env.OIDC_USERINFO_ENDPOINT || '').trim();
  const jwksUri = String(process.env.OIDC_JWKS_URI || '').trim();
  return {
    configured: Boolean(issuer && clientId && redirectUri),
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    authorizationEndpoint: authorizationEndpoint || undefined,
    tokenEndpoint: tokenEndpoint || undefined,
    userinfoEndpoint: userinfoEndpoint || undefined,
    jwksUri: jwksUri || undefined,
  };
}

@Injectable()
export class OidcService {
  private readonly prisma = getPrismaClient();
  private readonly logger = new Logger(OidcService.name);
  private readonly discoveryCache = new Map<
    string,
    { endpoints: OidcProviderEndpoints; expiresAt: number }
  >();

  constructor(private readonly authService: AuthService) {}

  envConfig(): OidcEnvConfig {
    return readOidcEnvConfig();
  }

  isConfigured(): boolean {
    return this.envConfig().configured;
  }

  postLoginRedirect(): string {
    const raw =
      String(process.env.OIDC_POST_LOGIN_REDIRECT || '').trim() ||
      String(process.env.WEB_ORIGIN || '').split(',')[0].trim();
    return raw || '/';
  }

  private requireConfig(): OidcEnvConfig {
    const config = this.envConfig();
    if (!config.configured) {
      throw new NotFoundException(
        'OIDC SSO is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI to enable it. Password login remains available.',
      );
    }
    return config;
  }

  private signState(body: string): string {
    const signature = createHmac('sha256', authSigningSecret()).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private verifyState(state: string): { nonce: string; ts: number } {
    const parts = String(state || '').split('.');
    const [body, signature] = parts;
    if (parts.length !== 2 || !body || !signature) throw new UnauthorizedException('Invalid OIDC state.');
    const expected = createHmac('sha256', authSigningSecret()).update(body).digest('base64url');
    const suppliedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new UnauthorizedException('Invalid OIDC state signature.');
    }
    let payload: { nonce?: string; ts?: number };
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid OIDC state payload.');
    }
    const ts = Number(payload?.ts || 0);
    if (!payload.nonce || !ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > STATE_TTL_SECONDS) {
      throw new UnauthorizedException('OIDC state has expired. Restart the SSO login.');
    }
    return { nonce: payload.nonce, ts };
  }

  private pickEndpoints(config: OidcEnvConfig, cached?: OidcProviderEndpoints): OidcProviderEndpoints {
    if (config.authorizationEndpoint && config.tokenEndpoint) {
      return {
        authorization_endpoint: config.authorizationEndpoint,
        token_endpoint: config.tokenEndpoint,
        userinfo_endpoint: config.userinfoEndpoint,
        jwks_uri: config.jwksUri,
      };
    }
    if (!cached) {
      throw new ServiceUnavailableException('OIDC discovery has not been loaded yet.');
    }
    return {
      ...cached,
      userinfo_endpoint: config.userinfoEndpoint || cached.userinfo_endpoint,
      jwks_uri: config.jwksUri || cached.jwks_uri,
    };
  }

  async loadEndpoints(config?: OidcEnvConfig): Promise<OidcProviderEndpoints> {
    const cfg = config || this.requireConfig();
    if (cfg.authorizationEndpoint && cfg.tokenEndpoint) {
      return this.pickEndpoints(cfg);
    }
    const cached = this.discoveryCache.get(cfg.issuer);
    if (cached && cached.expiresAt > Date.now()) {
      return this.pickEndpoints(cfg, cached.endpoints);
    }
    const discoveryUrl = `${cfg.issuer}/.well-known/openid-configuration`;
    let doc: any;
    try {
      const response = await fetch(discoveryUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`OIDC discovery returned HTTP ${response.status}`);
      }
      doc = await response.json();
    } catch (error) {
      this.logger.error(`OIDC discovery failed: ${String(error)}`);
      throw new ServiceUnavailableException(
        `Unable to load OIDC discovery document from ${discoveryUrl}.`,
      );
    }
    const endpoints: OidcProviderEndpoints = {
      authorization_endpoint: String(doc.authorization_endpoint || ''),
      token_endpoint: String(doc.token_endpoint || ''),
      userinfo_endpoint: String(doc.userinfo_endpoint || '') || undefined,
      jwks_uri: String(doc.jwks_uri || '') || undefined,
    };
    if (!endpoints.authorization_endpoint || !endpoints.token_endpoint) {
      throw new ServiceUnavailableException(
        'OIDC discovery document is missing required endpoints.',
      );
    }
    this.discoveryCache.set(cfg.issuer, { endpoints, expiresAt: Date.now() + 3600_000 });
    return this.pickEndpoints(cfg, endpoints);
  }

  /** Warm discovery for readiness probes / tests. */
  async prepare(): Promise<void> {
    await this.loadEndpoints(this.requireConfig());
  }

  async buildAuthorizationUrl(): Promise<{ url: string; state: string }> {
    const config = this.requireConfig();
    const endpoints = await this.loadEndpoints(config);
    const nonce = randomBytes(16).toString('base64url');
    const state = this.signState(
      Buffer.from(JSON.stringify({ nonce, ts: Math.floor(Date.now() / 1000) })).toString('base64url'),
    );
    const url = new URL(endpoints.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    return { url: url.toString(), state };
  }

  /**
   * CSRF guard: the state returned by the IdP must match the one we set in the
   * `llmwiki_oidc_state` cookie on the way out (double-submit) AND carry a valid
   * HMAC timestamp signature.
   */
  assertStateMatchesCookie(state: string, cookieState?: string | null): void {
    this.verifyState(state);
    if (!cookieState) {
      throw new UnauthorizedException('OIDC state cookie is missing. Restart the SSO login.');
    }
    const a = Buffer.from(String(state));
    const b = Buffer.from(String(cookieState));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('OIDC state mismatch. Restart the SSO login.');
    }
  }

  private async exchangeCode(
    config: OidcEnvConfig,
    endpoints: OidcProviderEndpoints,
    code: string,
  ): Promise<any> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (config.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
      ).toString('base64')}`;
    }
    const response = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => ({}))) as any;
    if (!response.ok || !payload.access_token) {
      this.logger.error(`OIDC token exchange failed: ${JSON.stringify(payload)}`);
      throw new UnauthorizedException(
        `OIDC token exchange failed: ${String(
          payload.error_description || payload.error || response.status,
        )}`,
      );
    }
    return payload;
  }

  private async fetchUserinfo(
    endpoints: OidcProviderEndpoints,
    accessToken: string,
  ): Promise<Record<string, unknown> | null> {
    if (!endpoints.userinfo_endpoint) return null;
    const response = await fetch(endpoints.userinfo_endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return payload && typeof payload === 'object' ? payload : null;
  }

  private verifyIdToken(
    idToken: string,
    jwks: any[],
    expectedNonce?: string,
    expectedIssuer?: string,
    expectedClientId?: string,
  ): Record<string, unknown> | null {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3 || !Array.isArray(jwks) || jwks.length === 0) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    let header: any;
    let payload: any;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (expectedNonce) {
      if (!payload.nonce) {
        throw new UnauthorizedException('OIDC id_token is missing the expected nonce.');
      }
      if (payload.nonce !== expectedNonce) {
        throw new UnauthorizedException('OIDC id_token nonce mismatch.');
      }
    }
    if (expectedIssuer && payload.iss !== expectedIssuer) {
      throw new UnauthorizedException('OIDC id_token issuer mismatch.');
    }
    if (expectedClientId) {
      const aud = payload.aud;
      const audList = Array.isArray(aud) ? aud : [aud];
      if (!audList.includes(expectedClientId)) {
        throw new UnauthorizedException('OIDC id_token audience mismatch.');
      }
      if (audList.length > 1 && payload.azp !== expectedClientId) {
        throw new UnauthorizedException('OIDC id_token authorized party mismatch.');
      }
    }
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload.exp) || payload.exp <= now ||
        !Number.isInteger(payload.iat) || payload.iat > now + 60 ||
        (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > now + 60))) {
      throw new UnauthorizedException('OIDC id_token is expired or has invalid timestamps.');
    }
    if (header.alg !== 'RS256') {
      this.logger.warn(
        `Unsupported id_token alg ${header.alg}; skipping signature verification path.`,
      );
      return null;
    }
    const keyJwk = jwks.find((k: any) => !header.kid || k.kid === header.kid);
    if (!keyJwk) return null;
    try {
      const key = createPublicKey({ key: keyJwk, format: 'jwk' });
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${headerB64}.${payloadB64}`);
      const ok = verifier.verify(key, signatureB64, 'base64url');
      return ok ? payload : null;
    } catch {
      return null;
    }
  }

  async loadJwks(jwksUri: string): Promise<any[]> {
    const response = await fetch(jwksUri, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new UnauthorizedException('Unable to load OIDC JWKS.');
    const doc = (await response.json()) as { keys?: any[] };
    return Array.isArray(doc.keys) ? doc.keys : [];
  }

  async resolveIdentity(
    tokenPayload: any,
    expectedNonce?: string,
  ): Promise<OidcIdentity> {
    const config = this.envConfig();
    const endpoints = await this.loadEndpoints(config);
    let idTokenClaims: Record<string, unknown> | null = null;
    if (tokenPayload.id_token) {
      if (!endpoints.jwks_uri) throw new UnauthorizedException('OIDC provider did not publish JWKS.');
      const jwks = await this.loadJwks(endpoints.jwks_uri);
      idTokenClaims = this.verifyIdToken(String(tokenPayload.id_token), jwks, expectedNonce, config.issuer, config.clientId);
      if (!idTokenClaims) throw new UnauthorizedException('OIDC id_token signature verification failed.');
    }
    let claims: Record<string, unknown> | null = await this.fetchUserinfo(
      endpoints,
      String(tokenPayload.access_token || ''),
    );
    if (claims && idTokenClaims && claims.sub !== idTokenClaims.sub) {
      throw new UnauthorizedException('OIDC userinfo subject does not match the id_token.');
    }
    claims ??= idTokenClaims;
    if (!claims) {
      throw new UnauthorizedException(
        'OIDC provider returned no userinfo/id_token claims; cannot identify the user.',
      );
    }
    const sub = String(claims.sub || '').trim();
    if (!sub) throw new UnauthorizedException('OIDC claims are missing `sub`.');
    const email = String(claims.email || '').trim().toLowerCase();
    const preferred = String(
      claims.preferred_username || claims.email || claims.name || sub,
    ).trim();
    const usernameSeed = preferred.split('@')[0] || `oidc_${sub.slice(0, 8)}`;
    return {
      sub,
      email: email || `${sub.replace(/[^A-Za-z0-9._-]/g, '_')}@oidc.local`,
      username: usernameSeed,
      displayName: String(claims.name || claims.preferred_username || usernameSeed).trim(),
      raw: claims,
    };
  }

  /**
   * Match an existing account by OIDC subject first, then by email (and bind
   * the subject), otherwise just-in-time provision a passwordless `source=oidc`
   * user. Always leaves with a local session (or an mfa ticket).
   */
  async matchOrProvisionUser(identity: OidcIdentity): Promise<string> {
    const bySub = await this.prisma.user.findUnique({ where: { oidcSub: identity.sub } });
    if (bySub) {
      if (bySub.status !== 'active') {
        throw new UnauthorizedException('User is inactive or does not exist.');
      }
      return bySub.id;
    }
    const byEmail = await this.prisma.user.findUnique({ where: { email: identity.email } });
    if (byEmail) {
      if (byEmail.status !== 'active') {
        throw new UnauthorizedException('User is inactive or does not exist.');
      }
      if (byEmail.oidcSub && byEmail.oidcSub !== identity.sub) {
        throw new BadRequestException(
          'This email is already linked to a different SSO identity. Contact an administrator.',
        );
      }
      if (!byEmail.oidcSub) {
        throw new BadRequestException(
          'This email has a local account. Please sign in with your existing credentials or contact an administrator to link SSO.',
        );
      }
      await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { oidcSub: identity.sub },
      });
      this.authService.invalidateUserStatus(byEmail.id);
      return byEmail.id;
    }
    const username = await this.uniqueUsername(identity.username);
    const created = await this.prisma.user.create({
      data: {
        username,
        displayName: identity.displayName || username,
        email: identity.email,
        passwordHash: null,
        mustChangePassword: false,
        status: 'active',
        source: 'oidc',
        oidcSub: identity.sub,
      },
    });
    return created.id;
  }

  private async uniqueUsername(seed: string): Promise<string> {
    const base =
      String(seed || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 40) || 'oidc_user';
    let candidate = base;
    for (let i = 0; i < 5; i += 1) {
      const clash = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!clash) return candidate;
      candidate = `${base}_${randomBytes(3).toString('hex')}`;
    }
    return `${base}_${randomBytes(6).toString('hex')}`;
  }

  async handleCallback(
    code: string,
    state: string,
    options: { cookieState?: string | null } = {},
  ): Promise<OidcCallbackResult> {
    const config = this.requireConfig();
    if (!code) throw new BadRequestException('Missing authorization `code`.');
    this.assertStateMatchesCookie(state, options.cookieState);
    const statePayload = this.verifyState(state);
    const endpoints = await this.loadEndpoints(config);
    const tokenPayload = await this.exchangeCode(config, endpoints, code);
    const identity = await this.resolveIdentity(tokenPayload, statePayload.nonce);
    const userId = await this.matchOrProvisionUser(identity);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } }, orgs: { include: { orgNode: true } } },
    });
    if (!user) throw new UnauthorizedException('User is inactive or does not exist.');
    if (user.mfaEnabled) {
      const { mfaToken, expiresIn } = this.authService.issueMfaToken(user.id);
      return { kind: 'mfa', mfaToken, expiresIn };
    }
    if (await this.authService.isMfaSetupRequired(user)) {
      const { mfaToken, expiresIn } = this.authService.issueMfaToken(user.id);
      return { kind: 'mfaSetup', mfaToken, expiresIn };
    }
    const session = await this.authService.completeLogin(user.id);
    return {
      kind: 'token',
      token: session.token,
      expiresIn: session.expiresIn,
      user: session.user as Record<string, unknown>,
    };
  }
}
