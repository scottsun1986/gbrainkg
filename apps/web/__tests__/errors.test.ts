/**
 * Unit tests for `src/lib/errors.ts` narrowing helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  errorMessage,
  errorName,
  asRecord,
  asArray,
  str,
  num,
  bool,
  apiMessage,
} from '../src/lib/errors';

describe('errorMessage / errorName', () => {
  it('reads Error instances', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom');
    assert.equal(errorName(new TypeError('bad')), 'TypeError');
  });

  it('reads message-like objects without instanceof', () => {
    assert.equal(errorMessage({ message: 'api down' }), 'api down');
    assert.equal(errorMessage({ name: 'AbortError' }), 'AbortError');
    assert.equal(errorName({ name: 'AbortError' }), 'AbortError');
  });

  it('falls back to empty string for non-message values', () => {
    assert.equal(errorMessage(null), '');
    assert.equal(errorMessage(42), '');
    assert.equal(errorMessage('plain'), 'plain');
    assert.equal(errorName('plain'), '');
  });
});

describe('asRecord / asArray', () => {
  it('narrows objects and rejects arrays/primitives', () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
    assert.deepEqual(asRecord([1, 2]), {});
    assert.deepEqual(asRecord('x'), {});
    assert.deepEqual(asRecord(null), {});
  });

  it('keeps real arrays and defaults others to []', () => {
    assert.deepEqual(asArray([1]), [1]);
    assert.deepEqual(asArray({ length: 1 }), []);
    assert.deepEqual(asArray(undefined), []);
  });
});

describe('str / num / bool', () => {
  it('coerces with fallbacks', () => {
    assert.equal(str('x'), 'x');
    assert.equal(str(3, 'fb'), 'fb');
    assert.equal(num(2.5), 2.5);
    assert.equal(num('9', -1), -1);
    assert.equal(num(Number.NaN, 7), 7);
    assert.equal(bool(''), false);
    assert.equal(bool('x'), true);
  });
});

describe('apiMessage', () => {
  it('prefers message then error field', () => {
    assert.equal(apiMessage({ message: 'm', error: 'e' }), 'm');
    assert.equal(apiMessage({ error: 'e' }), 'e');
    assert.equal(apiMessage({}), '');
    assert.equal(apiMessage('nope'), '');
  });
});
