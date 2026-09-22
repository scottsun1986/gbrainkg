import { detectCommunitiesLouvain } from './louvain';

describe('detectCommunitiesLouvain', () => {
  it('separates two dense cliques joined by a single weak edge', () => {
    // Two triangles connected by one edge. BFS connected components would
    // return a single 6-node community; Louvain must split them.
    const nodes = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'];
    const edges = [
      { source: 'a1', target: 'a2', weight: 3 },
      { source: 'a2', target: 'a3', weight: 3 },
      { source: 'a3', target: 'a1', weight: 3 },
      { source: 'b1', target: 'b2', weight: 3 },
      { source: 'b2', target: 'b3', weight: 3 },
      { source: 'b3', target: 'b1', weight: 3 },
      { source: 'a1', target: 'b1', weight: 0.1 },
    ];

    const result = detectCommunitiesLouvain(nodes, edges);

    expect(result.communities).toHaveLength(2);
    const groups = result.communities.map((c) => c.slice().sort().join(''));
    expect(groups).toContain('a1a2a3');
    expect(groups).toContain('b1b2b3');
    expect(result.modularity).toBeGreaterThan(0.3);
  });

  it('is deterministic across runs and independent of input order', () => {
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'];
    const edges = [
      { source: 'n1', target: 'n2', weight: 2 },
      { source: 'n2', target: 'n3', weight: 2 },
      { source: 'n1', target: 'n3', weight: 2 },
      { source: 'n3', target: 'n4', weight: 0.2 },
      { source: 'n4', target: 'n5', weight: 2 },
    ];

    const first = detectCommunitiesLouvain(nodes, edges);
    const second = detectCommunitiesLouvain(nodes.slice().reverse(), edges.slice().reverse());

    expect(second.communities).toEqual(first.communities);
    expect(second.modularity).toBe(first.modularity);
  });

  it('keeps isolated nodes as singleton communities', () => {
    const result = detectCommunitiesLouvain(['x', 'y', 'z'], [{ source: 'x', target: 'y', weight: 1 }]);
    const singleton = result.communities.find((c) => c.length === 1);
    expect(singleton).toEqual(['z']);
  });

  it('handles an empty graph', () => {
    expect(detectCommunitiesLouvain([], [])).toEqual({ communities: [], modularity: 0, levels: 0 });
  });
});
