import { routeGraphQuery, graphProbeEnabledForQuery } from './graph-rag.service';

describe('routeGraphQuery (P2-3 corpus-agnostic graph routing)', () => {
  it('routes theme/overview questions to global_theme (no local graph probe)', () => {
    expect(routeGraphQuery('这套制度体系的整体框架是什么')).toBe('global_theme');
    expect(routeGraphQuery('summarize all of the maintenance regulations')).toBe('global_theme');
  });

  it('routes relation/bridge questions to multi_hop (local graph probe on)', () => {
    expect(routeGraphQuery('A 部门和 B 部门之间的审批关系是什么')).toBe('multi_hop');
    expect(routeGraphQuery('compare the difference between SLA and OLA')).toBe('multi_hop');
  });

  it('routes plain factual questions to local_fact', () => {
    expect(routeGraphQuery('报销标准是多少')).toBe('local_fact');
    expect(routeGraphQuery('What is the on-call phone number?')).toBe('local_fact');
  });

  it('enables the probe only for multi-hop under auto routing', () => {
    const previous = process.env.GRAPHRAG_ROUTE;
    try {
      delete process.env.GRAPHRAG_ROUTE;
      expect(graphProbeEnabledForQuery('甲和乙之间的关系')).toBe(true);
      expect(graphProbeEnabledForQuery('报销标准是多少')).toBe(false);
      process.env.GRAPHRAG_ROUTE = 'always';
      expect(graphProbeEnabledForQuery('报销标准是多少')).toBe(true);
      process.env.GRAPHRAG_ROUTE = 'off';
      expect(graphProbeEnabledForQuery('甲和乙之间的关系')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GRAPHRAG_ROUTE;
      else process.env.GRAPHRAG_ROUTE = previous;
    }
  });
});
