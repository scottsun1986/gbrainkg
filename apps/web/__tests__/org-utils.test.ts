/**
 * Unit tests for `src/lib/org-utils.ts` pure org-tree helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  flattenOrgTree,
  getSubtreeOrgIds,
  countSubtreeUsers,
} from '../src/lib/org-utils';

const tree = {
  id: 'root',
  name: 'HQ',
  canManage: true,
  children: [
    {
      id: 'a',
      name: 'Compliance',
      canManage: true,
      children: [{ id: 'a1', name: 'SubA1', children: [] }],
    },
    { id: 'b', name: 'R&D', children: [] },
  ],
};

describe('flattenOrgTree', () => {
  it('returns depth-first nodes with human-readable paths', () => {
    const flat = flattenOrgTree(tree);
    assert.deepEqual(
      flat.map((n) => n.id),
      ['root', 'a', 'a1', 'b'],
    );
    assert.equal(flat[0].path, 'HQ');
    assert.equal(flat[1].path, 'HQ / Compliance');
    assert.equal(flat[2].path, 'HQ / Compliance / SubA1');
    assert.equal(flat[0].canManage, true);
    assert.equal(flat[3].canManage, false);
  });

  it('accepts an array of roots and empty input', () => {
    assert.equal(flattenOrgTree([tree, { id: 'x', name: 'X', children: [] }]).length, 5);
    assert.deepEqual(flattenOrgTree(null), []);
    assert.deepEqual(flattenOrgTree([]), []);
  });
});

describe('getSubtreeOrgIds', () => {
  it('collects the node and all descendants as a Set', () => {
    const ids = getSubtreeOrgIds(tree.children[0]);
    assert.ok(ids instanceof Set);
    assert.deepEqual([...ids].sort(), ['a', 'a1']);
  });

  it('returns an empty set for null', () => {
    assert.equal(getSubtreeOrgIds(null).size, 0);
  });
});

describe('countSubtreeUsers', () => {
  it('counts users whose orgIds intersect the subtree', () => {
    const users = [
      { id: 'u1', orgIds: ['a1'] },
      { id: 'u2', orgIds: ['b'] },
      { id: 'u3', orgIds: ['a', 'b'] },
      { id: 'u4', orgIds: [] },
    ];
    assert.equal(countSubtreeUsers(tree.children[0], users), 2); // u1 + u3
    assert.equal(countSubtreeUsers(tree, users), 3);
    assert.equal(countSubtreeUsers(null, users), 0);
  });
});
