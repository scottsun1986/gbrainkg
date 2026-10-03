import { UnauthorizedException } from '@nestjs/common';
import {
  AUTH_DEV_FALLBACK_SECRET,
  AUTH_SECRET_MIN_LENGTH,
  authSigningSecret,
  signingSecretFor,
  usingDevelopmentSecret,
} from './auth-secret';

/**
 * These cases exist because the previous implementation fell back to a
 * repository-visible literal whenever `NODE_ENV` was unset or misspelled, which
 * let a misconfigured deployment sign real sessions with a public constant.
 */
describe('auth signing secret resolution', () => {
  const original = {
    AUTH_SECRET: process.env.AUTH_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    LLMWIKI_ALLOW_DEV_SECRET: process.env.LLMWIKI_ALLOW_DEV_SECRET,
    PREVIEW_TOKEN_SECRET: process.env.PREVIEW_TOKEN_SECRET,
  };

  const strong = 'x'.repeat(AUTH_SECRET_MIN_LENGTH);

  beforeEach(() => {
    delete process.env.AUTH_SECRET;
    delete process.env.NODE_ENV;
    delete process.env.LLMWIKI_ALLOW_DEV_SECRET;
    delete process.env.PREVIEW_TOKEN_SECRET;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses a configured AUTH_SECRET', () => {
    process.env.AUTH_SECRET = strong;
    expect(authSigningSecret()).toBe(strong);
    expect(usingDevelopmentSecret()).toBe(false);
  });

  it('rejects a configured AUTH_SECRET that is too short', () => {
    process.env.AUTH_SECRET = 'short';
    expect(() => authSigningSecret()).toThrow(/at least 32 characters/);
  });

  it('fails closed when NODE_ENV is unset, even though a fallback literal exists', () => {
    expect(() => authSigningSecret()).toThrow(/AUTH_SECRET is not configured/);
  });

  it('fails closed when NODE_ENV is misspelled rather than explicitly development', () => {
    process.env.NODE_ENV = 'prod';
    process.env.LLMWIKI_ALLOW_DEV_SECRET = '1';
    expect(() => authSigningSecret()).toThrow(/AUTH_SECRET is not configured/);
  });

  it('fails closed in development unless the operator opts in', () => {
    process.env.NODE_ENV = 'development';
    expect(() => authSigningSecret()).toThrow(/AUTH_SECRET is not configured/);
  });

  it('uses the development literal only for an explicit development opt-in', () => {
    process.env.NODE_ENV = 'development';
    process.env.LLMWIKI_ALLOW_DEV_SECRET = '1';
    expect(authSigningSecret()).toBe(AUTH_DEV_FALLBACK_SECRET);
    expect(usingDevelopmentSecret()).toBe(true);
  });

  it('accepts test as a development environment', () => {
    process.env.NODE_ENV = 'test';
    process.env.LLMWIKI_ALLOW_DEV_SECRET = 'true';
    expect(authSigningSecret()).toBe(AUTH_DEV_FALLBACK_SECRET);
  });

  it('never treats production as a development environment', () => {
    process.env.NODE_ENV = 'production';
    process.env.LLMWIKI_ALLOW_DEV_SECRET = '1';
    expect(() => authSigningSecret()).toThrow(/AUTH_SECRET is not configured/);
  });

  describe('purpose-specific secrets', () => {
    it('prefers the dedicated variable', () => {
      const dedicated = 'p'.repeat(AUTH_SECRET_MIN_LENGTH);
      process.env.PREVIEW_TOKEN_SECRET = dedicated;
      process.env.AUTH_SECRET = strong;
      expect(signingSecretFor('preview', 'PREVIEW_TOKEN_SECRET')).toBe(dedicated);
    });

    it('falls through to session signing when the dedicated variable is absent', () => {
      process.env.AUTH_SECRET = strong;
      expect(signingSecretFor('preview', 'PREVIEW_TOKEN_SECRET')).toBe(strong);
    });

    it('does not silently reuse the development literal for a second purpose', () => {
      process.env.NODE_ENV = 'production';
      expect(() => signingSecretFor('preview', 'PREVIEW_TOKEN_SECRET')).toThrow(
        /No signing secret available for preview/,
      );
    });
  });
});
