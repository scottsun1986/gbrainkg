/**
 * Unit tests for the pure force-layout routine exported from
 * `KnowledgeGraphScreen.tsx`. `runForceLayout` is a deterministic (modulo
 * Math.random jitter) simulation with no DOM/React dependency in its body.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runForceLayout,
  type GraphNode,
  type GraphEdge,
} from '../src/components/knowledge-graph/KnowledgeGraphScreen';

const nodes: GraphNode[] = [
  { id: 'n1', label: 'Alpha', type: 'concept' },
  { id: 'n2', label: 'Beta', type: 'document' },
  { id: 'n3', label: 'Gamma', type: 'knowledge_base' },
];

const edges: GraphEdge[] = [
  { source: 'n1', target: 'n2', type: 'related' },
  { source: 'n2', target: 'n3', type: 'contains', weight: 2 },
];

describe('runForceLayout', () => {
  it('returns one layout node per input node, preserving ids', () => {
    const laidOut = runForceLayout(nodes, edges, { iterations: 5 });
    assert.equal(laidOut.length, nodes.length);
    assert.deepEqual(
      laidOut.map((n) => n.id).sort(),
      nodes.map((n) => n.id).sort(),
    );
  });

  it('keeps positions inside the requested viewport bounds', () => {
    const width = 900;
    const height = 600;
    const laidOut = runForceLayout(nodes, edges, { width, height, iterations: 5 });
    for (const n of laidOut) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} has finite coords`);
      assert.ok(n.x >= 60 && n.x <= width - 60, `${n.id}.x=${n.x} within [60, ${width - 60}]`);
      assert.ok(n.y >= 60 && n.y <= height - 60, `${n.id}.y=${n.y} within [60, ${height - 60}]`);
    }
  });

  it('handles an empty graph without throwing', () => {
    assert.deepEqual(runForceLayout([], []), []);
  });

  it('ignores edges that reference missing nodes', () => {
    const laidOut = runForceLayout(nodes, [{ source: 'ghost', target: 'n1', type: 'related' }], {
      iterations: 3,
    });
    assert.equal(laidOut.length, nodes.length);
  });
});
