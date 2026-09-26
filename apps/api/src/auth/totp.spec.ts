import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  totpAt,
  verifyTotp,
} from './totp';

/**
 * RFC 4226 / RFC 6238 test vectors.
 * Secret is the ASCII string "12345678901234567890" (160-bit HMAC-SHA1 key).
 */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 6238) / HOTP (RFC 4226)', () => {
  describe('base32 (RFC 4648)', () => {
    it('encodes known vectors', () => {
      expect(base32Encode(Buffer.from(''))).toBe('');
      expect(base32Encode(Buffer.from('f'))).toBe('MY');
      expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
      expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6');
      expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    });

    it('round-trips random secrets', () => {
      for (let i = 0; i < 8; i += 1) {
        const { base32, raw } = generateTotpSecret();
        expect(base32Decode(base32).equals(raw)).toBe(true);
      }
    });

    it('rejects invalid characters', () => {
      expect(() => base32Decode('MZXW6YTB0I')).toThrow(/Invalid base32/);
    });
  });

  describe('HOTP (RFC 4226 Appendix D 6-digit vectors)', () => {
    // Secret 0x313233... ("12345678901234567890"), 6 digits.
    const vectors: Array<[number, string]> = [
      [0, '755224'],
      [1, '287082'],
      [2, '359152'],
      [3, '969429'],
      [4, '338314'],
      [5, '254676'],
      [6, '287922'],
      [7, '162583'],
      [8, '399871'],
      [9, '520489'],
    ];
    it.each(vectors)('counter %i → %s', (counter, expected) => {
      expect(hotp(RFC_SECRET, counter, 6)).toBe(expected);
    });
  });

  describe('TOTP (RFC 6238 Appendix B, SHA-1)', () => {
    // RFC vectors are 8-digit. Time is Unix seconds, step 30, T0 = 0.
    const rfc8: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    it.each(rfc8)('t=%i → %s (8-digit)', (t, expected) => {
      expect(totpAt(RFC_SECRET, t, 30, 8)).toBe(expected);
    });

    // 6-digit truncation of the same codes (last 6 digits).
    const rfc6: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    it.each(rfc6)('t=%i → %s (6-digit)', (t, expected) => {
      expect(totpAt(RFC_SECRET, t, 30, 6)).toBe(expected);
    });
  });

  describe('verifyTotp', () => {
    const t = 1111111111; // code 050471 (6-digit)

    it('accepts the code for the current step', () => {
      expect(verifyTotp(RFC_SECRET, '050471', { timestampSec: t, window: 0 })).toBe(true);
    });

    it('accepts neighbouring steps inside the window', () => {
      // t+30 produces 14050471 → 050471 differs; use window to accept prev step code at t+10
      expect(verifyTotp(RFC_SECRET, '050471', { timestampSec: t + 25, window: 1 })).toBe(true);
    });

    it('rejects codes outside the window', () => {
      expect(verifyTotp(RFC_SECRET, '050471', { timestampSec: t + 300, window: 1 })).toBe(false);
      expect(verifyTotp(RFC_SECRET, '000000', { timestampSec: t, window: 1 })).toBe(false);
    });

    it('rejects malformed codes without throwing', () => {
      expect(verifyTotp(RFC_SECRET, 'abc', { timestampSec: t })).toBe(false);
      expect(verifyTotp(RFC_SECRET, '', { timestampSec: t })).toBe(false);
      expect(verifyTotp(RFC_SECRET, '12345', { timestampSec: t })).toBe(false);
    });

    it('is constant-time safe against equal-length wrong codes (still false)', () => {
      expect(verifyTotp(RFC_SECRET, '050472', { timestampSec: t, window: 0 })).toBe(false);
    });
  });

  describe('otpauth URI', () => {
    it('builds a scan-friendly URI', () => {
      const uri = buildOtpauthUri({
        secretBase32: 'JBSWY3DPEHPK3PXP',
        account: 'alice@example.com',
        issuer: 'GBrainKG',
        digits: 6,
        period: 30,
      });
      expect(uri.startsWith('otpauth://totp/')).toBe(true);
      expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
      expect(uri).toContain('issuer=GBrainKG');
      expect(uri).toContain('algorithm=SHA1');
      expect(uri).toContain('digits=6');
      expect(uri).toContain('period=30');
      expect(uri).toContain('alice%40example.com');
    });
  });
});
