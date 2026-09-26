/**
 * HOTP (RFC 4226) / TOTP (RFC 6238) with HMAC-SHA1, implemented on `node:crypto`
 * only — no npm dependency. Base32 (RFC 4648) for secret encoding as required by
 * the otpauth:// URI scheme used by authenticator apps.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function hotp(secret: Buffer, counter: number | bigint, digits = 6): string {
  if (digits < 6 || digits > 10) throw new Error('TOTP digits must be between 6 and 10.');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpAt(
  secret: Buffer,
  timestampSec: number,
  stepSeconds = 30,
  digits = 6,
): string {
  const counter = Math.floor(timestampSec / stepSeconds);
  return hotp(secret, counter, digits);
}

export function totpNow(secret: Buffer, stepSeconds = 30, digits = 6): string {
  return totpAt(secret, Math.floor(Date.now() / 1000), stepSeconds, digits);
}

export interface TotpVerifyOptions {
  /** Adjacent time steps accepted on each side of the current one (RFC 6238 §5.2 recommended window). */
  window?: number;
  timestampSec?: number;
  stepSeconds?: number;
  digits?: number;
}

export function verifyTotp(
  secret: Buffer,
  code: string,
  options: TotpVerifyOptions = {},
): boolean {
  const cleaned = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6,10}$/.test(cleaned)) return false;
  const window = options.window ?? 1;
  const stepSeconds = options.stepSeconds ?? 30;
  const digits = options.digits ?? cleaned.length;
  const timestampSec = options.timestampSec ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(timestampSec / stepSeconds);
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = hotp(secret, counter + drift, digits);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(cleaned.padStart(expected.length, '0'), 'utf8');
    if (
      expectedBuf.length === actualBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return true;
    }
  }
  return false;
}

/** 20-byte (160-bit) secret as recommended by RFC 4226 §4. */
export function generateTotpSecret(): { base32: string; raw: Buffer } {
  const raw = randomBytes(20);
  return { base32: base32Encode(raw), raw };
}

export function buildOtpauthUri(params: {
  secretBase32: string;
  account: string;
  issuer?: string;
  digits?: number;
  period?: number;
}): string {
  const issuer = params.issuer || 'GBrainKG';
  const label = encodeURIComponent(`${issuer}:${params.account}`).replace(/%3A/g, ':');
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(params.digits ?? 6),
    period: String(params.period ?? 30),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
