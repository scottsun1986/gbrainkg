import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { AuthService } from './auth.service';
import { OidcService, readOidcEnvConfig, OidcIdentity } from './oidc.service';
import { getPrismaClient } from '../prisma';

const prisma = getPrismaClient();

const ISSUER = 'https://idp.example.com';
const discoveryDoc = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  jwks_uri: `${ISSUER}/jwks`,
};

function jsonResponse(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function enableOidc() {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = 'gbrainkg-web';
  process.env.OIDC_CLIENT_SECRET = 'shhh-secret';
  process.env.OIDC_REDIRECT_URI = 'https://kb.example.com/api/v1/auth/oidc/callback';
  process.env.OIDC_SCOPES = 'openid email profile';
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'llmwiki-unittest-secret';
}

function disableOidc() {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.OIDC_AUTHORIZATION_ENDPOINT;
  delete process.env.OIDC_TOKEN_ENDPOINT;
  delete process.env.OIDC_USERINFO_ENDPOINT;
  delete process.env.OIDC_JWKS_URI;
}

function signRs256IdToken(payloadObj: Record<string, unknown>, privateKey: any, kid = 'test-key') {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

describe('OIDC SSO (authorization code + JIT provisioning)', () => {
  let authService: AuthService;
  let oidcService: OidcService;

  beforeEach(() => {
    enableOidc();
    authService = new AuthService();
    oidcService = new OidcService(authService);
    jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) {
        return jsonResponse(discoveryDoc);
      }
      if (url.endsWith('/token')) {
        return jsonResponse({ access_token: 'at-123', token_type: 'Bearer' });
      }
      if (url.endsWith('/userinfo')) {
        return jsonResponse({
          sub: 'idp-user-1',
          email: 'new.user@example.com',
          preferred_username: 'new.user',
          name: 'New User',
        });
      }
      return jsonResponse({}, 404);
    });
    jest.spyOn(prisma.user, 'findUnique').mockResolvedValue(null as any);
    jest.spyOn(prisma.user, 'create').mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      username: 'new.user',
      email: 'new.user@example.com',
      status: 'active',
      roles: [],
      orgs: [],
      mfaEnabled: false,
      mfaSecret: null,
    } as any);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({} as any);
    (prisma as any).systemSetting = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    disableOidc();
  });

  it('unconfigured OIDC surfaces NotFound (501-class) and leaves password login alone', async () => {
    disableOidc();
    expect(oidcService.isConfigured()).toBe(false);
    expect(readOidcEnvConfig().configured).toBe(false);
    await expect(oidcService.buildAuthorizationUrl()).rejects.toThrow(NotFoundException);
    await expect(oidcService.handleCallback('code', 'state', { skipCookieCheck: true })).rejects.toThrow(
      NotFoundException,
    );
    expect(typeof authService.login).toBe('function');
  });

  it('readOidcEnvConfig flags incomplete configuration as unconfigured', () => {
    delete process.env.OIDC_CLIENT_ID;
    expect(readOidcEnvConfig().configured).toBe(false);
  });

  it('buildAuthorizationUrl issues a signed state and the IdP authorize URL', async () => {
    const { url, state } = await oidcService.buildAuthorizationUrl();
    expect(url.startsWith(`${ISSUER}/authorize?`)).toBe(true);
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=gbrainkg-web');
    expect(url).toContain('scope=openid');
    expect(url).toContain(`state=${encodeURIComponent(state)}`);
    expect(url).toContain('nonce=');
    expect(() => oidcService.assertStateMatchesCookie(state, state)).not.toThrow();
  });

  it('rejects a forged state', async () => {
    const { state } = await oidcService.buildAuthorizationUrl();
    const forged = `${state.slice(0, -1)}x${state.slice(-1) === 'x' ? 'y' : 'x'}`;
    expect(() => oidcService.assertStateMatchesCookie(forged, forged)).toThrow(UnauthorizedException);
  });

  it('rejects when the double-submit cookie is missing or mismatched', async () => {
    const { state } = await oidcService.buildAuthorizationUrl();
    expect(() => oidcService.assertStateMatchesCookie(state, undefined)).toThrow(
      UnauthorizedException,
    );
    expect(() => oidcService.assertStateMatchesCookie(state, 'other')).toThrow(
      UnauthorizedException,
    );
  });

  it('callback JIT-provisions a brand new user from userinfo claims', async () => {
    const { state } = await oidcService.buildAuthorizationUrl();
    const createdId = '22222222-2222-4222-8222-222222222222';
    (prisma.user.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.id === createdId) {
        return {
          id: createdId,
          username: 'new.user',
          displayName: 'New User',
          email: 'new.user@example.com',
          passwordHash: null,
          mustChangePassword: false,
          status: 'active',
          source: 'oidc',
          mfaSecret: null,
          mfaEnabled: false,
          mfaEnabledAt: null,
          oidcSub: 'idp-user-1',
          createdAt: new Date(),
          roles: [],
          orgs: [],
        };
      }
      return null;
    });

    const result: any = await oidcService.handleCallback('authz-code', state, {
      cookieState: state,
    });

    expect(result.kind).toBe('token');
    expect(result.token).toBeTruthy();
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect((prisma.user.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
      email: 'new.user@example.com',
      source: 'oidc',
      oidcSub: 'idp-user-1',
      passwordHash: null,
      mustChangePassword: false,
    });
  });

  it('callback binds an existing email user to the OIDC subject instead of duplicating', async () => {
    const { state } = await oidcService.buildAuthorizationUrl();
    const existing = {
      id: '33333333-3333-4333-8333-333333333333',
      username: 'old.user',
      displayName: 'Old User',
      email: 'new.user@example.com',
      passwordHash: 'scrypt$aa$bb',
      mustChangePassword: false,
      status: 'active',
      source: 'manual',
      mfaSecret: null,
      mfaEnabled: false,
      mfaEnabledAt: null,
      oidcSub: null as string | null,
      createdAt: new Date(),
      roles: [],
      orgs: [],
    };
    (prisma.user.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.email === 'new.user@example.com') return existing;
      if (args?.where?.id === existing.id) return existing;
      return null;
    });

    const result: any = await oidcService.handleCallback('authz-code', state, {
      cookieState: state,
    });

    expect(result.kind).toBe('token');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: existing.id },
        data: { oidcSub: 'idp-user-1' },
      }),
    );
  });

  it('callback issues an mfaToken (not a session) when the user has MFA enabled', async () => {
    const { state } = await oidcService.buildAuthorizationUrl();
    const existing = {
      id: '44444444-4444-4444-8444-444444444444',
      username: 'mfa.user',
      displayName: 'MFA User',
      email: 'new.user@example.com',
      passwordHash: 'scrypt$aa$bb',
      mustChangePassword: false,
      status: 'active',
      source: 'manual',
      mfaSecret: 'JBSWY3DPEHPK3PXP',
      mfaEnabled: true,
      mfaEnabledAt: new Date(),
      oidcSub: 'idp-user-1',
      createdAt: new Date(),
      roles: [],
      orgs: [],
    };
    (prisma.user.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.email === 'new.user@example.com') return existing;
      if (args?.where?.id === existing.id || args?.where?.oidcSub === 'idp-user-1') return existing;
      return null;
    });

    const result: any = await oidcService.handleCallback('authz-code', state, {
      cookieState: state,
    });

    expect(result.kind).toBe('mfa');
    expect(result.mfaToken).toBeTruthy();
    expect(result.token).toBeUndefined();
  });

  it('matchOrProvisionUser rejects an email already bound to a different subject', async () => {
    (prisma.user.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.email) {
        return {
          id: '55555555-5555-4555-8555-555555555555',
          status: 'active',
          oidcSub: 'someone-else',
          email: 'new.user@example.com',
        };
      }
      return null;
    });
    const identity: OidcIdentity = {
      sub: 'idp-user-1',
      email: 'new.user@example.com',
      username: 'new.user',
      displayName: 'New User',
      raw: {},
    };
    await expect(oidcService.matchOrProvisionUser(identity)).rejects.toThrow();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('OIDC id_token RS256 verification fallback (node:crypto + JWKS)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    disableOidc();
  });

  it('accepts a correctly signed id_token when userinfo is unavailable', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as any;
    jwk.kid = 'test-key';
    const idToken = signRs256IdToken(
      {
        sub: 'idp-user-3',
        email: 'idtoken3.user@example.com',
        preferred_username: 'idtoken3.user',
        name: 'Id Token 3',
        nonce: 'known-nonce',
      },
      privateKey,
    );

    enableOidc();
    const authService = new AuthService();
    const oidcService = new OidcService(authService);

    jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) {
        // no userinfo_endpoint → forces the id_token path
        return jsonResponse({
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        });
      }
      if (url.endsWith('/jwks')) return jsonResponse({ keys: [jwk] });
      return jsonResponse({}, 404);
    });

    const identity = await oidcService.resolveIdentity(
      { access_token: 'no-userinfo', id_token: idToken },
      'known-nonce',
    );
    expect(identity.sub).toBe('idp-user-3');
    expect(identity.email).toBe('idtoken3.user@example.com');
    expect(identity.username).toBe('idtoken3.user');
  });

  it('rejects an id_token whose nonce does not match the OIDC state', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as any;
    jwk.kid = 'test-key';
    const idToken = signRs256IdToken(
      { sub: 'idp-user-3', email: 'a@b.c', nonce: 'attacker-nonce' },
      privateKey,
    );

    enableOidc();
    const authService = new AuthService();
    const oidcService = new OidcService(authService);

    jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) {
        return jsonResponse({
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        });
      }
      if (url.endsWith('/jwks')) return jsonResponse({ keys: [jwk] });
      return jsonResponse({}, 404);
    });

    await expect(
      oidcService.resolveIdentity({ access_token: 'x', id_token: idToken }, 'expected-nonce'),
    ).rejects.toThrow(UnauthorizedException);
  });
});
