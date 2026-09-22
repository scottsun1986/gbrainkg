/**
 * Unit tests for `src/lib/capabilities.ts` permission helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasCapability,
  canAccessAdmin,
  canAccessSettings,
  ADMIN_NAV_PERMISSIONS,
} from '../src/lib/capabilities';

describe('hasCapability', () => {
  it('matches wildcard or explicit permission', () => {
    assert.equal(hasCapability('kb.read', ['*']), true);
    assert.equal(hasCapability('kb.read', ['kb.read']), true);
    assert.equal(hasCapability('kb.write', ['kb.read']), false);
    assert.equal(hasCapability('kb.read', []), false);
  });
});

describe('canAccessAdmin', () => {
  it('grants on wildcard or any admin nav permission', () => {
    assert.equal(canAccessAdmin(['*']), true);
    assert.equal(canAccessAdmin(['org.read']), true);
    assert.equal(canAccessAdmin(['audit.read']), true);
    assert.equal(canAccessAdmin(['chat.use']), false);
    assert.equal(canAccessAdmin([]), false);
    assert.ok(ADMIN_NAV_PERMISSIONS.includes('role.read'));
  });
});

describe('canAccessSettings', () => {
  it('accepts read or manage system settings', () => {
    assert.equal(canAccessSettings(['system.settings.read']), true);
    assert.equal(canAccessSettings(['system.settings.manage']), true);
    assert.equal(canAccessSettings(['*']), true);
    assert.equal(canAccessSettings(['kb.read']), false);
  });
});
