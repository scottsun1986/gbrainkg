import {
  extractRoutingTokens,
  scoreKbRelevance,
  routeKnowledgeBasesByIntent,
  KnowledgeBaseMetadata,
  kbMetaCache,
} from './kb-intent-router';

describe('kb-intent-router', () => {
  beforeEach(() => {
    kbMetaCache.clear();
  });

  describe('extractRoutingTokens', () => {
    it('extracts English terms and Chinese multi-grams', () => {
      const tokens = extractRoutingTokens('请问财务报销的标准和流程是什么？');
      expect(tokens).toContain('财务');
      expect(tokens).toContain('报销');
      expect(tokens).toContain('标准');
      expect(tokens).toContain('流程');
    });

    it('handles alphanumeric codes', () => {
      const tokens = extractRoutingTokens('PRD-2026 规范文档');
      expect(tokens).toContain('prd-2026');
      expect(tokens).toContain('规范');
    });
  });

  describe('scoreKbRelevance', () => {
    const kbFinance: KnowledgeBaseMetadata = {
      id: 'kb-fin',
      name: '财务管理与差旅报销制度',
      description: '包含差旅标准、日常报销发票规范等财务细则',
      domainTerms: ['报销', '发票', '差旅费'],
    };

    const kbDev: KnowledgeBaseMetadata = {
      id: 'kb-dev',
      name: '研发工程与技术架构',
      description: '微服务架构设计与代码发布流程',
      domainTerms: ['nestjs', 'postgres', 'docker'],
    };

    it('scores higher for matching domain and title terms', () => {
      const tokens = ['差旅', '报销', '标准'];
      const finScore = scoreKbRelevance(kbFinance, tokens);
      const devScore = scoreKbRelevance(kbDev, tokens);

      expect(finScore).toBeGreaterThan(10);
      expect(devScore).toBe(0);
    });
  });

  describe('routeKnowledgeBasesByIntent', () => {
    const kbs: KnowledgeBaseMetadata[] = [
      { id: 'kb-1', name: '财务管理制度', domainTerms: ['报销', '发票'] },
      { id: 'kb-2', name: '人事规章手册', domainTerms: ['年假', '考勤', '薪酬'] },
      { id: 'kb-3', name: '研发架构设计', domainTerms: ['微服务', 'API', 'Docker'] },
      { id: 'kb-4', name: '法务合规指南', domainTerms: ['合同', '保密协议'] },
      { id: 'kb-5', name: '市场宣传材料', domainTerms: ['品牌', '展会'] },
    ];

    const fetchFn = jest.fn().mockImplementation(async (ids: string[]) => {
      return kbs.filter((k) => ids.includes(k.id));
    });

    it('bypasses routing when scope has 2 or fewer KBs', async () => {
      const result = await routeKnowledgeBasesByIntent('财务', ['kb-1', 'kb-2'], fetchFn);
      expect(result.routed).toBe(false);
      expect(result.targetedScope).toEqual(['kb-1', 'kb-2']);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('narrows scope to top matching KBs when query has clear intent', async () => {
      const scope = ['kb-1', 'kb-2', 'kb-3', 'kb-4', 'kb-5'];
      const result = await routeKnowledgeBasesByIntent('我想查询年假和日常考勤打卡要求', scope, fetchFn);

      expect(result.routed).toBe(true);
      expect(result.targetedScope).toContain('kb-2'); // 人事规章
      expect(result.targetedScope.length).toBeLessThanOrEqual(3);
      expect(result.targetedScope).not.toContain('kb-3'); // 研发架构 excluded
    });

    it('falls back to full scope when query has no matching affinity', async () => {
      const scope = ['kb-1', 'kb-2', 'kb-3', 'kb-4', 'kb-5'];
      const result = await routeKnowledgeBasesByIntent('今天天气怎么样？', scope, fetchFn);

      expect(result.routed).toBe(false);
      expect(result.targetedScope).toEqual(scope);
    });
  });
});
