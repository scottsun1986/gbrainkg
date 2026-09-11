import { AgenticRagService } from './agentic-rag.service';

describe('AgenticRagService', () => {
  const modelConfigService = {
    getDefault: jest.fn().mockResolvedValue({
      provider: { baseUrl: 'https://llm.example.com/v1', apiKey: 'test-key' },
      modelName: 'test-model',
    }),
    getLlmChatConfig: jest.fn().mockResolvedValue({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'test-key',
      modelName: 'test-model',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
    }),
  } as any;

  let service: AgenticRagService;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HYDE_ENABLED;
    service = new AgenticRagService(modelConfigService);
  });

  describe('classifyQuery', () => {
    it('classifies simple questions', async () => {
      await expect(service.classifyQuery('第十条是什么？')).resolves.toBe('simple');
    });

    it('classifies comparative questions', async () => {
      await expect(service.classifyQuery('研发与量产阶段的参数差异对比')).resolves.toBe('comparative');
    });

    it('classifies global synthesis questions', async () => {
      await expect(service.classifyQuery('请总结一下所有章节的主要内容都有哪些')).resolves.toBe('global_synthesis');
    });

    it('classifies multi-hop questions with conjunctions', async () => {
      await expect(
        service.classifyQuery('如果设备在雨雪天偏航，并且传感器未检修，该怎么处理？'),
      ).resolves.toBe('multi_hop');
    });
  });

  describe('planQuery', () => {
    it('returns the original query and no HyDE for simple questions', async () => {
      process.env.QUERY_EXPANSION_ENABLED = 'false';
      try {
        const plan = await service.planQuery('第十条是什么？');
        expect(plan.complexity).toBe('simple');
        expect(plan.subQueries).toEqual(['第十条是什么？']);
        expect(plan.hyde).toBeNull();
      } finally {
        delete process.env.QUERY_EXPANSION_ENABLED;
      }
    });

    it('plans complex questions in unified mode with subQueries and expansions in one call', async () => {
      const originalFetch = global.fetch;
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: { content: '{"subQueries":["子问题A","子问题B"],"expansions":["安全距离","冗余裕度"],"reasoning":"统一拆解与术语扩展"}' },
          }],
        }),
      });
      try {
        const plan = await service.planQuery('对比研发与量产阶段的参数差异');
        expect(plan.complexity).toBe('comparative');
        expect(plan.subQueries).toEqual(['子问题A', '子问题B']);
        expect(plan.expansions).toEqual(['安全距离', '冗余裕度']);
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it('supports separate planning mode when AGENTIC_UNIFIED_PLAN is false', async () => {
      process.env.AGENTIC_UNIFIED_PLAN = 'false';
      process.env.HYDE_ENABLED = 'true';
      const originalFetch = global.fetch;
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"subQueries":["子问题A","子问题B"],"reasoning":"拆分"}' } }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '假设性专业答复：安全距离不得低于120米。' } }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '{"expansions":["安全距离","冗余裕度"]}' } }],
          }),
        });
      try {
        const plan = await service.planQuery('对比研发与量产阶段的参数差异');
        expect(plan.complexity).toBe('comparative');
        expect(plan.subQueries).toEqual(['子问题A', '子问题B']);
        expect(plan.hyde).toContain('120米');
        expect(plan.expansions).toEqual(['安全距离', '冗余裕度']);
      } finally {
        delete process.env.AGENTIC_UNIFIED_PLAN;
        delete process.env.HYDE_ENABLED;
        (global as any).fetch = originalFetch;
      }
    });
  });

  describe('expandQuery', () => {
    it('returns model-provided canonical terms and caches them', async () => {
      const originalFetch = global.fetch;
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"expansions":["夏令时","作息时间"]}' } }],
        }),
      });
      (global as any).fetch = fetchMock;
      try {
        const terms = await service.expandQuery('员工夏天几点上班');
        expect(terms).toEqual(['夏令时', '作息时间']);
        // Second call must be served from the in-process cache.
        await service.expandQuery('员工夏天几点上班');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it('respects the QUERY_EXPANSION_ENABLED=false switch', async () => {
      process.env.QUERY_EXPANSION_ENABLED = 'false';
      await expect(service.expandQuery('员工夏天几点上班')).resolves.toEqual([]);
      delete process.env.QUERY_EXPANSION_ENABLED;
    });
  });

  describe('generateHypotheticalDocument', () => {
    it('respects the HYDE_ENABLED=false switch', async () => {
      process.env.HYDE_ENABLED = 'false';
      await expect(service.generateHypotheticalDocument('任意问题')).resolves.toBeNull();
      delete process.env.HYDE_ENABLED;
    });

    it('recovers the passage from reasoning_content for reasoning models', async () => {
      const originalFetch = global.fetch;
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '', reasoning_content: '思考：用户要一段专业文本。\n\n我们来起草：\n\n激光陀螺仪标定应在恒温无振动环境下进行，零偏与标度因数须覆盖全量程，并进行地球自转补偿。' } }],
        }),
      });
      try {
        const hyde = await service.generateHypotheticalDocument('激光陀螺仪标定要求');
        expect(hyde).toContain('恒温无振动');
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it('fails open to null when the model call errors', async () => {
      const originalFetch = global.fetch;
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
      try {
        await expect(service.generateHypotheticalDocument('任意问题')).resolves.toBeNull();
      } finally {
        (global as any).fetch = originalFetch;
      }
    });
  });

  describe('judgeRetrievalSufficiency', () => {
    it('returns sufficient when max hops reached', async () => {
      const res = await service.judgeRetrievalSufficiency('对比研发与量产区别', '上下文内容', 3);
      expect(res.status).toBe('sufficient');
      expect(res.hopNumber).toBe(3);
    });

    it('returns irrelevant when context is empty', async () => {
      const res = await service.judgeRetrievalSufficiency('对比研发与量产区别', '   ', 1);
      expect(res.status).toBe('irrelevant');
      expect(res.suggestedFollowUp).toContain('对比研发与量产区别');
    });

    it('detects missing entity in comparative question via heuristic coverage fallback', async () => {
      const originalFetch = global.fetch;
      // Simulate LLM failure or timeout
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('timeout'));
      try {
        const res = await service.judgeRetrievalSufficiency(
          '研发与量产阶段的参数差异对比',
          '研发阶段需要进行原型机验证，各项参数测试充分。',
          1,
          { complexity: 'comparative', executedProbes: ['研发与量产阶段的参数差异对比'] },
        );
        expect(res.status).toBe('insufficient');
        expect(res.missingAspects[0]).toContain('量产');
        expect(res.suggestedFollowUp[0]).toContain('量产');
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it('uses model evaluation to output reasoning and non-repeating follow-up queries', async () => {
      const originalFetch = global.fetch;
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                status: 'insufficient',
                confidence: 0.85,
                reasoning: '缺少量产阶段参数与公差要求',
                missingAspects: ['量产公差'],
                suggestedFollowUp: ['量产阶段参数标准', '已执行过的查询'],
              }),
            },
          }],
        }),
      });
      try {
        const res = await service.judgeRetrievalSufficiency(
          '对比研发与量产阶段的公差与测试要求',
          '研发阶段公差要求为0.05mm。',
          1,
          { executedProbes: ['已执行过的查询'] },
        );
        expect(res.status).toBe('insufficient');
        expect(res.reasoning).toBe('缺少量产阶段参数与公差要求');
        expect(res.suggestedFollowUp).toContain('量产阶段参数标准');
        expect(res.suggestedFollowUp).not.toContain('已执行过的查询');
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    it('fast-passes comparative query with zero LLM calls when both documents and entities are fully covered', async () => {
      const originalFetch = global.fetch;
      const fetchMock = jest.fn();
      (global as any).fetch = fetchMock;
      try {
        const res = await service.judgeRetrievalSufficiency(
          '研发与量产阶段的参数差异对比',
          '《研发管理规范》研发阶段需经过严谨验证。《量产制造手册》量产阶段参数须符合公差要求。',
          1,
          { complexity: 'comparative' },
        );
        expect(res.status).toBe('sufficient');
        expect(res.confidence).toBeGreaterThanOrEqual(0.9);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        (global as any).fetch = originalFetch;
      }
    });
  });
});
