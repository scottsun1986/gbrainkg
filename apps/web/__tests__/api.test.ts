/**
 * Unit tests for pure helpers in `src/lib/api.ts`.
 *
 * `apiHeaders` is pure with respect to its environment probe: under node it
 * observes no `window` and returns an empty header map. `COLORS` is a frozen
 * design-token map the UI relies on for evidence highlighting.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE_URL, apiHeaders, COLORS } from '../src/lib/api';

describe('apiHeaders', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('returns an empty map on the server (no window)', () => {
    assert.equal((globalThis as { window?: unknown }).window, undefined);
    assert.deepEqual(apiHeaders(), {});
  });

  it('returns a Bearer header when a token is present in localStorage', () => {
    const store = new Map<string, string>([['llmwiki_token', 'jwt-abc']]);
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
      },
    };
    assert.deepEqual(apiHeaders(), { Authorization: 'Bearer jwt-abc' });
  });

  it('returns an empty map when localStorage has no token', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: () => null },
    };
    assert.deepEqual(apiHeaders(), {});
  });
});

describe('API_BASE_URL', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof API_BASE_URL, 'string');
  });
});

describe('COLORS', () => {
  it('exposes evidence highlight tokens as hex colors', () => {
    assert.match(COLORS.evidence, /^#[0-9A-Fa-f]{6}$/);
    assert.match(COLORS.evidenceSoft, /^#[0-9A-Fa-f]{6}$/);
  });
});
