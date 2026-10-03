/**
 * Single source of truth for the HMAC secret that signs session tokens, OIDC
 * state and model-credential envelopes.
 *
 * The previous per-service implementations fell back to a literal
 * `'llmwiki-local-development-secret'` whenever AUTH_SECRET was unset. Two
 * production failure modes followed from that:
 *
 *  1. `NODE_ENV` unset or misspelled (e.g. `prod`, `Production `) - the
 *     service did not recognise it as production, so it silently signed real
 *     user tokens with a secret that is committed to this repository, letting
 *     anyone who reads the source forge an arbitrary identity.
 *  2. The same class of typo made OIDC `state` forgeable, which is the CSRF
 *     binding for the login callback.
 *
 * Resolution is now explicit and opt-in: the development fallback is used only
 * when LLMWIKI_ALLOW_DEV_SECRET is set to a truthy value AND NODE_ENV is an
 * explicit development/test value. Anything else requires a real AUTH_SECRET
 * of at least 32 characters, otherwise we fail closed at first use.
 */

const DEV_FALLBACK_SECRET = 'llmwiki-local-development-secret';
const MIN_SECRET_LENGTH = 32;

/** NODE_ENV values that unambiguously denote a non-production runtime. */
const DEV_ENVIRONMENTS = new Set(['development', 'dev', 'test']);

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isExplicitDevEnvironment(): boolean {
  return DEV_ENVIRONMENTS.has(String(process.env.NODE_ENV ?? '').trim().toLowerCase());
}

/**
 * Returns the signing secret, or throws when no safe value is available.
 *
 * Callers must let the throw propagate: a request that cannot be
 * cryptographically bound must fail rather than proceed with a shared literal.
 */
export function authSigningSecret(): string {
  const configured = String(process.env.AUTH_SECRET ?? '').trim();
  if (configured) {
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters; got ${configured.length}.`,
      );
    }
    return configured;
  }

  // The fallback now requires BOTH an explicit development NODE_ENV and an
  // explicit opt-in flag. Either one alone is a configuration mistake, not a
  // licence to sign with a public constant.
  if (isExplicitDevEnvironment() && isTruthy(process.env.LLMWIKI_ALLOW_DEV_SECRET)) {
    return DEV_FALLBACK_SECRET;
  }

  throw new Error(
    'AUTH_SECRET is not configured (set a random value of at least 32 characters). ' +
      'For local development only, set NODE_ENV=development and LLMWIKI_ALLOW_DEV_SECRET=1 ' +
      'to use the shared development secret.',
  );
}

/** True when the current process would sign with the shared development secret. */
export function usingDevelopmentSecret(): boolean {
  if (String(process.env.AUTH_SECRET ?? '').trim()) return false;
  return isExplicitDevEnvironment() && isTruthy(process.env.LLMWIKI_ALLOW_DEV_SECRET);
}

/** Exposed for startup self-checks and tests. */
export const AUTH_SECRET_MIN_LENGTH = MIN_SECRET_LENGTH;
export const AUTH_DEV_FALLBACK_SECRET = DEV_FALLBACK_SECRET;

/**
 * Signing secret for a specific purpose that may carry its own dedicated key.
 *
 * Document preview tokens control read access to stored files. They used to
 * fall back to the same public literal as sessions, so a forged preview token
 * reached any document whose id could be guessed. A purpose-specific key is
 * preferred; when absent the value falls through to the same explicit
 * resolution rules as session signing (never to a silent literal).
 */
export function signingSecretFor(
  purpose: string,
  dedicatedEnvVar: string,
): string {
  const dedicated = String(process.env[dedicatedEnvVar] ?? '').trim();
  if (dedicated) {
    if (dedicated.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `${dedicatedEnvVar} must be at least ${MIN_SECRET_LENGTH} characters; got ${dedicated.length}.`,
      );
    }
    return dedicated;
  }
  try {
    return authSigningSecret();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`No signing secret available for ${purpose}: ${detail}`);
  }
}
