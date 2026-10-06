import { positiveNumber } from './config-numbers';

/**
 * These call sites feed loop bounds and SQL `LIMIT`/`slice` arguments. A
 * misspelled value previously produced NaN, which silently emptied loops
 * (`offset += NaN`) or failed the whole query (`LIMIT NaN`) with no log.
 */
describe('positiveNumber', () => {
  it('uses the fallback for unset, empty and non-numeric values', () => {
    for (const value of [undefined, null, '', 'abc', '8x', {}, []]) {
      expect(positiveNumber(value, 64)).toBe(64);
    }
  });

  it('uses the fallback for non-finite and out-of-range numbers', () => {
    for (const value of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(positiveNumber(value, 64)).toBe(64);
    }
  });

  it('keeps valid values, including values below a caller-supplied floor', () => {
    expect(positiveNumber('8', 64)).toBe(8);
    expect(positiveNumber(1, 64)).toBe(1);
    expect(positiveNumber('2.5', 64)).toBe(2.5);
  });

  it('enforces an explicit minimum', () => {
    expect(positiveNumber('3', 64, 8)).toBe(64);
    expect(positiveNumber('9', 64, 8)).toBe(9);
  });
});
