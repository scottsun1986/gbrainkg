/**
 * Deterministic Louvain community detection for the knowledge graph.
 *
 * The previous implementation used BFS connected components, which answers a
 * different question: "is there a path between these entities", not "which
 * entities form a densely linked community". A single long reference chain
 * merged unrelated topics into one component (and the 30-node cap then silently
 * dropped entities from every community).
 *
 * This is the standard two-phase Louvain heuristic (Blondel et al., 2008):
 *  1. local moving — repeatedly move a node into the neighbouring community
 *     that yields the largest modularity gain, until no move improves it;
 *  2. aggregation — collapse each community into a single node and repeat.
 *
 * The implementation is deliberately deterministic (nodes are visited in a
 * stable, sorted order and ties resolve by lowest community id) so the
 * community fingerprint used for incremental reuse does not churn between runs.
 * It is a heuristic — no exact-optimality claim — but it optimises modularity
 * instead of connectivity.
 */

export interface LouvainEdge {
  source: string;
  target: string;
  weight?: number;
}

export interface LouvainOptions {
  /** Bounded to keep a single enrichment job predictable (default 10). */
  maxLevels?: number;
  /** Granularity: >1 favours more, smaller communities (default 1). */
  resolution?: number;
  /** Safety bound on local-moving sweeps per level (default 50). */
  maxSweepsPerLevel?: number;
}

export interface LouvainResult {
  /** Each inner array is one community's original node ids, largest first. */
  communities: string[][];
  /** Final modularity of the flat partition. */
  modularity: number;
  levels: number;
}

type WeightedAdjacency = Map<string, Map<string, number>>;

function buildAdjacency(nodes: string[], edges: LouvainEdge[]): {
  adjacency: WeightedAdjacency;
  selfLoops: Map<string, number>;
  totalWeight: number;
} {
  const adjacency: WeightedAdjacency = new Map();
  const selfLoops = new Map<string, number>();
  for (const node of nodes) adjacency.set(node, new Map());

  let totalWeight = 0;
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    if (!adjacency.has(source) || !adjacency.has(target)) continue;
    const weight = Number.isFinite(Number(edge.weight)) && Number(edge.weight) > 0
      ? Number(edge.weight)
      : 1;
    if (source === target) {
      selfLoops.set(source, (selfLoops.get(source) || 0) + weight);
      totalWeight += weight;
      continue;
    }
    const sourceLinks = adjacency.get(source)!;
    sourceLinks.set(target, (sourceLinks.get(target) || 0) + weight);
    const targetLinks = adjacency.get(target)!;
    targetLinks.set(source, (targetLinks.get(source) || 0) + weight);
    totalWeight += weight;
  }
  return { adjacency, selfLoops, totalWeight };
}

/** One Louvain level: local moving over a (possibly aggregated) graph. */
function localMoving(
  adjacency: WeightedAdjacency,
  selfLoops: Map<string, number>,
  totalWeight: number,
  resolution: number,
  maxSweeps: number,
): Map<string, string> {
  const nodes = Array.from(adjacency.keys()).sort();
  const communityOf = new Map<string, string>();
  const communityTotal = new Map<string, number>();
  const weightOf = new Map<string, number>();

  const total = totalWeight > 0 ? totalWeight : 1;
  for (const node of nodes) {
    communityOf.set(node, node);
    const degree = Array.from(adjacency.get(node)!.values()).reduce((a, b) => a + b, 0)
      + (selfLoops.get(node) || 0) * 2;
    weightOf.set(node, degree);
    communityTotal.set(node, degree);
  }

  const m2 = 2 * total;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let moved = false;
    for (const node of nodes) {
      const currentCommunity = communityOf.get(node)!;
      const nodeDegree = weightOf.get(node) || 0;
      const neighbours = adjacency.get(node)!;

      // Sum of edge weights from this node into each candidate community.
      const weightToCommunity = new Map<string, number>();
      for (const [neighbour, weight] of neighbours) {
        const community = communityOf.get(neighbour)!;
        weightToCommunity.set(community, (weightToCommunity.get(community) || 0) + weight);
      }

      const removalGain = (() => {
        const totalCurrent = communityTotal.get(currentCommunity) || 0;
        const without = totalCurrent - nodeDegree;
        const within = weightToCommunity.get(currentCommunity) || 0;
        // ΔQ when the node leaves: -(within/m) + resolution * degree * (total-without)/(2m²)
        return -(within / total) + resolution * nodeDegree * (without / (m2 * total));
      })();

      let bestCommunity = currentCommunity;
      let bestGain = 0;
      for (const [candidate, weight] of Array.from(weightToCommunity.entries()).sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      )) {
        if (candidate === currentCommunity) continue;
        const totalCandidate = communityTotal.get(candidate) || 0;
        // ΔQ when the node joins: (weight/m) - resolution * degree * totalCandidate/(2m²)
        const gain = weight / total - resolution * nodeDegree * (totalCandidate / (m2 * total));
        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = candidate;
        }
      }

      // Net gain must be positive after accounting for the removal cost.
      if (bestCommunity !== currentCommunity && bestGain + removalGain > 1e-12) {
        communityTotal.set(currentCommunity, (communityTotal.get(currentCommunity) || 0) - nodeDegree);
        communityTotal.set(bestCommunity, (communityTotal.get(bestCommunity) || 0) + nodeDegree);
        communityOf.set(node, bestCommunity);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return communityOf;
}

function aggregate(
  communityOf: Map<string, string>,
  adjacency: WeightedAdjacency,
  selfLoops: Map<string, number>,
): { adjacency: WeightedAdjacency; selfLoops: Map<string, number> } {
  const nextAdjacency: WeightedAdjacency = new Map();
  const nextSelfLoops = new Map<string, number>();
  const seen = new Set<string>();

  for (const [node, community] of communityOf) {
    if (!nextAdjacency.has(community)) nextAdjacency.set(community, new Map());
    if (!seen.has(node)) {
      seen.add(node);
      for (const [neighbour, weight] of adjacency.get(node) || []) {
        const neighbourCommunity = communityOf.get(neighbour);
        if (neighbourCommunity === undefined) continue;
        if (neighbourCommunity === community) {
          // Internal edges become self loops; counted from both endpoints, so
          // halve the contribution to avoid double counting.
          nextSelfLoops.set(community, (nextSelfLoops.get(community) || 0) + weight / 2);
        } else {
          const links = nextAdjacency.get(community)!;
          links.set(neighbourCommunity, (links.get(neighbourCommunity) || 0) + weight);
        }
      }
    }
    const loop = selfLoops.get(node);
    if (loop) nextSelfLoops.set(community, (nextSelfLoops.get(community) || 0) + loop);
  }
  return { adjacency: nextAdjacency, selfLoops: nextSelfLoops };
}

/** Modularity of a partition over the original (unaggregated) graph. */
function modularityOf(
  nodes: string[],
  edges: LouvainEdge[],
  communityOf: Map<string, string>,
  resolution: number,
): number {
  const degree = new Map<string, number>();
  const internal = new Map<string, number>();
  const communityTotal = new Map<string, number>();
  let m2 = 0;

  for (const node of nodes) degree.set(node, 0);
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    if (degree.get(source) === undefined || degree.get(target) === undefined) continue;
    const weight = Number.isFinite(Number(edge.weight)) && Number(edge.weight) > 0
      ? Number(edge.weight)
      : 1;
    degree.set(source, (degree.get(source) || 0) + weight);
    degree.set(target, (degree.get(target) || 0) + weight);
    m2 += 2 * weight;
    if (source !== target && communityOf.get(source) === communityOf.get(target)) {
      const community = communityOf.get(source)!;
      internal.set(community, (internal.get(community) || 0) + 2 * weight);
    }
  }
  if (m2 === 0) return 0;
  for (const [node, deg] of degree) {
    const community = communityOf.get(node) || node;
    communityTotal.set(community, (communityTotal.get(community) || 0) + deg);
  }

  let q = 0;
  for (const [community, total] of communityTotal) {
    const within = internal.get(community) || 0;
    q += within / m2 - resolution * Math.pow(total / m2, 2);
  }
  return q;
}

export function detectCommunitiesLouvain(
  nodes: string[],
  edges: LouvainEdge[],
  options: LouvainOptions = {},
): LouvainResult {
  const uniqueNodes = Array.from(new Set(nodes.map(String)));
  if (!uniqueNodes.length) return { communities: [], modularity: 0, levels: 0 };

  const resolution = Number.isFinite(Number(options.resolution)) && Number(options.resolution) > 0
    ? Number(options.resolution)
    : 1;
  const maxLevels = Math.max(1, Math.min(20, Number(options.maxLevels || 10)));
  const maxSweeps = Math.max(1, Math.min(200, Number(options.maxSweepsPerLevel || 50)));

  // `membership.get(node)` always maps an original node to its current super-node.
  const membership = new Map<string, string>(uniqueNodes.map((node) => [node, node]));
  let { adjacency, selfLoops, totalWeight } = buildAdjacency(uniqueNodes, edges);
  let levels = 0;

  for (let level = 0; level < maxLevels; level++) {
    const levelAssignment = localMoving(adjacency, selfLoops, totalWeight, resolution, maxSweeps);
    const distinct = new Set(levelAssignment.values());
    if (distinct.size === adjacency.size) break; // no merge happened at this level
    levels += 1;

    for (const node of uniqueNodes) {
      const superNode = levelAssignment.get(membership.get(node)!) ?? membership.get(node)!;
      membership.set(node, superNode);
    }

    const aggregated = aggregate(levelAssignment, adjacency, selfLoops);
    adjacency = aggregated.adjacency;
    selfLoops = aggregated.selfLoops;
    totalWeight = 0;
    for (const links of adjacency.values()) {
      for (const weight of links.values()) totalWeight += weight;
    }
    totalWeight = totalWeight / 2 + Array.from(selfLoops.values()).reduce((a, b) => a + b, 0);
    if (adjacency.size <= 1) break;
  }

  const grouped = new Map<string, string[]>();
  for (const node of uniqueNodes) {
    const community = membership.get(node)!;
    if (!grouped.has(community)) grouped.set(community, []);
    grouped.get(community)!.push(node);
  }

  // Sort inside each community as well: the partition must be identical for the
  // same graph regardless of the order nodes/edges were supplied in, because
  // the result feeds a community fingerprint used for incremental reuse.
  for (const members of grouped.values()) members.sort();

  const communities = Array.from(grouped.values()).sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  return {
    communities,
    modularity: Number(modularityOf(uniqueNodes, edges, membership, resolution).toFixed(6)),
    levels,
  };
}
