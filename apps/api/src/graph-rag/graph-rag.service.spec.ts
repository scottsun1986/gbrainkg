import { GraphRagService } from './graph-rag.service';

const mockPrisma = {
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn(),
  graphEntity: {
    upsert: jest.fn(),
    findMany: jest.fn(),
  },
  graphRelation: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  graphCommunity: {
    deleteMany: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));

describe('GraphRagService', () => {
  let service: GraphRagService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GraphRagService();
  });

  describe('classifyEntityType', () => {
    it('correctly classifies organizations', () => {
      expect(service.classifyEntityType('腾讯科技有限公司')).toBe('organization');
      expect(service.classifyEntityType('安全研发中心')).toBe('organization');
      expect(service.classifyEntityType('架构委员会')).toBe('organization');
    });

    it('correctly classifies systems and platforms', () => {
      expect(service.classifyEntityType('向量检索系统')).toBe('system');
      expect(service.classifyEntityType('知识库管理平台')).toBe('system');
      expect(service.classifyEntityType('推理引擎')).toBe('system');
    });

    it('correctly classifies policies and standards', () => {
      expect(service.classifyEntityType('《数据安全管理条例》')).toBe('policy');
      expect(service.classifyEntityType('知识工程实施准则')).toBe('policy');
      expect(service.classifyEntityType('开发行为规范')).toBe('policy');
    });

    it('falls back to concept for generic terms', () => {
      expect(service.classifyEntityType('语义嵌入')).toBe('concept');
      expect(service.classifyEntityType('图神经网络')).toBe('concept');
    });
  });

  describe('extractGraphElements', () => {
    it('extracts entities and relations from document title and chunk contents', () => {
      const title = '腾讯WeKnora知识库系统接入规范.md';
      const docId = 'doc-123';
      const chunks = [
        {
          id: 'chunk-1',
          content: `# 系统架构概览\n本系统依托《数据合规指南》进行设计，由腾讯科技有限公司负责运维。关于模型细节请参考 [[向量检索服务]]。`,
        },
      ];

      const { entities, relations } = service.extractGraphElements(title, docId, chunks);

      // Document root entity
      expect(entities.some((e) => e.name === '腾讯WeKnora知识库系统接入规范' && e.type === 'document')).toBe(true);

      // Extracted concept from heading
      expect(entities.some((e) => e.name === '系统架构概览' && e.type === 'concept')).toBe(true);

      // Extracted policy from book quotes
      expect(entities.some((e) => e.name === '数据合规指南' && e.type === 'policy')).toBe(true);

      // Extracted org
      expect(entities.some((e) => e.name === '腾讯科技有限公司' && e.type === 'organization')).toBe(true);

      // Extracted wikilink
      expect(entities.some((e) => e.name === '向量检索服务')).toBe(true);

      // Relations
      expect(relations.some((r) => r.relationType === 'contains' && r.targetName === '系统架构概览')).toBe(true);
      expect(relations.some((r) => r.relationType === 'references' && r.targetName === '数据合规指南')).toBe(true);
      expect(relations.some((r) => r.relationType === 'mentions' && r.targetName === '腾讯科技有限公司')).toBe(true);
      expect(relations.some((r) => r.relationType === 'relates_to' && r.targetName === '向量检索服务')).toBe(true);
    });

    it('ignores trivial or generic words', () => {
      const { entities } = service.extractGraphElements('测试文档', 'doc-1', [
        { content: '# 目录\n# 文档正文\n# 附件' },
      ]);
      expect(entities.some((e) => ['目录', '文档正文', '附件'].includes(e.name))).toBe(false);
    });

    it('extracts temporal supersedes and amends relations from policy text', () => {
      const { relations } = service.extractGraphElements('安全运营规范V4.md', 'doc-v4', [
        { content: '本规范自发布之日起施行，废止《旧版飞行管理规定》，并修订《数据中心运维守则》。' },
      ], 4);
      expect(relations.some((r) => r.relationType === 'supersedes' && r.targetName === '旧版飞行管理规定')).toBe(true);
      expect(relations.some((r) => r.relationType === 'amends' && r.targetName === '数据中心运维守则')).toBe(true);
    });
  });

  describe('persistGraphElements', () => {
    it('persists entities and relations gracefully', async () => {
      mockPrisma.graphEntity.upsert
        .mockResolvedValueOnce({ id: 'ent-1', name: '系统A' })
        .mockResolvedValueOnce({ id: 'ent-2', name: '服务B' });

      // Entities are upserted with one batched statement that returns ids.
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'ent-1', name: '系统A' },
          { id: 'ent-2', name: '服务B' },
        ])
        .mockResolvedValueOnce([{ id: 'rel-1' }]);

      const res = await service.persistGraphElements('kb-1', {
        entities: [
          { name: '系统A', type: 'system' },
          { name: '服务B', type: 'system' },
        ],
        relations: [
          { sourceName: '系统A', targetName: '服务B', relationType: 'depends_on' },
        ],
      });

      expect(res.entityCount).toBe(2);
      expect(res.relationCount).toBe(1);
      // One round trip for every entity, one for every relation batch: the
      // serial N+1 upsert loop is gone.
      expect(mockPrisma.graphEntity.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.graphRelation.create).not.toHaveBeenCalled();
      expect(mockPrisma.graphRelation.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
      const entitySql = (mockPrisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      expect(entitySql).toContain('ON CONFLICT ("kbId", "name") DO UPDATE');
      const relationSql = (mockPrisma.$queryRaw.mock.calls[1][0] as TemplateStringsArray).join(' ');
      expect(relationSql).toContain('ON CONFLICT ("sourceId", "targetId", "relationType") DO UPDATE');
    });

    it('returns zeroes when entity list is empty', async () => {
      const res = await service.persistGraphElements('kb-1', { entities: [], relations: [] });
      expect(res).toEqual({ entityCount: 0, relationCount: 0 });
      expect(mockPrisma.graphEntity.upsert).not.toHaveBeenCalled();
    });

    it('appends provenance when updating existing relations with documentVersion', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'ent-1', name: '系统A' },
          { id: 'ent-2', name: '服务B' },
        ])
        .mockResolvedValueOnce([{ id: 'rel-1' }]);

      const res = await service.persistGraphElements('kb-1', {
        entities: [
          { name: '系统A', type: 'system' },
          { name: '服务B', type: 'system' },
        ],
        relations: [
          {
            sourceName: '系统A',
            targetName: '服务B',
            relationType: 'depends_on',
            provenanceDocId: 'doc-1',
            documentVersion: 2,
            chunkId: 'c2',
            snippet: 'new snippet',
          },
        ],
      });

      expect(res.relationCount).toBe(1);
      expect(mockPrisma.graphRelation.update).not.toHaveBeenCalled();
      // The union of existing provenance and the new observation happens
      // inside the database; the statement must express it as a JSONB concat
      // guarded by containment so a repeated observation is not duplicated.
      const relationSql = (mockPrisma.$queryRaw.mock.calls[1][0] as TemplateStringsArray).join(' ');
      expect(relationSql).toContain('@> COALESCE(EXCLUDED."provenance"');
      expect(mockPrisma.$queryRaw.mock.calls[1]).toContain(
        JSON.stringify([
          {
            sourceId: 'ent-1',
            targetId: 'ent-2',
            relationType: 'depends_on',
            weight: 1,
            description: null,
            provenance: [
              { documentId: 'doc-1', documentVersion: 2, chunkId: 'c2', snippet: 'new snippet' },
            ],
          },
        ]),
      );
    });

    it('merges entity document provenance for existing entities', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'ent-1', name: '系统A' }]);
      await service.persistGraphElements('kb-1', {
        entities: [{ name: '系统A', type: 'system', sourceDocId: 'doc-2' }],
        relations: [],
      });

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      const sql = mockPrisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray;
      expect(sql.join(' ')).toContain('jsonb_to_recordset');
      expect(mockPrisma.$executeRaw.mock.calls[0]).toContain(
        JSON.stringify([{ id: 'ent-1', docId: 'doc-2' }]),
      );
    });

    it('surfaces relation persistence failures so enrichment can retry', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'ent-1', name: '系统A' },
          { id: 'ent-2', name: '服务B' },
        ])
        .mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.persistGraphElements('kb-1', {
        entities: [
          { name: '系统A', type: 'system' },
          { name: '服务B', type: 'system' },
        ],
        relations: [
          { sourceName: '系统A', targetName: '服务B', relationType: 'depends_on' },
        ],
      })).rejects.toThrow('Failed to persist 1/1 graph relations');
    });
  });

  describe('buildCommunitiesForKb', () => {
    it('returns 0 if no entities found', async () => {
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([]);
      const count = await service.buildCommunitiesForKb('kb-1');
      expect(count).toBe(0);
    });

    it('clusters connected entities and stores communities with summaries', async () => {
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([
        {
          id: 'e1',
          name: '向量索引引擎',
          type: 'system',
          outgoingRelations: [{ targetId: 'e2' }],
        },
        {
          id: 'e2',
          name: 'Milvus集群',
          type: 'system',
          outgoingRelations: [],
        },
      ]);
      mockPrisma.graphCommunity.deleteMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.graphCommunity.create.mockResolvedValueOnce({ id: 'comm-1' });

      const count = await service.buildCommunitiesForKb('kb-1');
      expect(count).toBe(1);
      expect(mockPrisma.graphCommunity.deleteMany).toHaveBeenCalledWith({ where: { kbId: 'kb-1' } });
      expect(mockPrisma.graphCommunity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kbId: 'kb-1',
            level: 0,
            entityIds: ['e1', 'e2'],
          }),
        }),
      );
    });
  });

  describe('searchLocalGraph', () => {
    it('returns empty when query has no valid terms or empty kbIds', async () => {
      const emptyRes = await service.searchLocalGraph([], 'hello');
      expect(emptyRes.entities).toHaveLength(0);

      const blankRes = await service.searchLocalGraph(['kb-1'], ' ');
      expect(blankRes.entities).toHaveLength(0);
    });

    it('retrieves matching entities and expands outgoing and incoming relations', async () => {
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([
        {
          id: 'e1',
          name: '鉴权中台',
          type: 'system',
          description: '统一身份与权限中枢',
          outgoingRelations: [
            {
              relationType: 'regulates',
              weight: 2.0,
              provenance: [{ documentId: 'd1', chunkId: 'c1', snippet: '依据RBAC模型' }],
              target: { name: '数据访问网关', type: 'system' },
            },
          ],
          incomingRelations: [],
        },
      ]);

      const result = await service.searchLocalGraph(['kb-1'], '鉴权中台如何运作');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('鉴权中台');
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].provenance).toEqual([
        { documentId: 'd1', chunkId: 'c1', snippet: '依据RBAC模型' },
      ]);
      expect(result.formattedContext).toContain('【知识图谱关联事实 (GraphRAG Local Search)】');
      expect(result.formattedContext).toContain('[鉴权中台] (system) --[regulates]--> [数据访问网关] (system)');
    });
  });

  describe('searchGlobalCommunities', () => {
    it('returns empty when kbIds is empty', async () => {
      const result = await service.searchGlobalCommunities([], '架构');
      expect(result.communities).toHaveLength(0);
      expect(result.formattedContext).toBe('');
    });

    it('matches and scores community summaries by query terms', async () => {
      mockPrisma.graphCommunity.findMany.mockResolvedValueOnce([
        {
          id: 'comm-1',
          title: '身份认证与权限管理体系 (社区 1)',
          summary: '本知识社区涵盖鉴权、SSO网关等核心安全组件。',
          findings: ['核心实体：鉴权中台'],
        },
        {
          id: 'comm-2',
          title: '前端构建与样式指南 (社区 2)',
          summary: '关于UI组件库规范与TailwindCSS最佳实践。',
          findings: ['核心实体：Antd'],
        },
      ]);

      const result = await service.searchGlobalCommunities(['kb-1'], '权限 认证', 1);

      expect(result.communities).toHaveLength(1);
      expect(result.communities[0].id).toBe('comm-1');
      expect(result.formattedContext).toContain('【知识图谱社区宏观摘要 (GraphRAG Global Search)】');
      expect(result.formattedContext).toContain('身份认证与权限管理体系');
    });

    it('does not return a community with zero keyword relevance', async () => {
      mockPrisma.graphCommunity.findMany.mockResolvedValueOnce([
        { id: 'comm-1', title: '身份认证', summary: '权限管理体系', findings: [] },
      ]);
      const result = await service.searchGlobalCommunities(['kb-1'], '食堂菜单', 1);
      expect(result.communities).toEqual([]);
      expect(result.formattedContext).toBe('');
    });
  });

  describe('planDriftQueries', () => {
    it('uses community summaries only to select canonical entity probes', async () => {
      jest.spyOn(service, 'searchGlobalCommunities').mockResolvedValue({
        communities: [{ id: 'comm-1', title: '权限体系', summary: 'generated summary', findings: [] }],
        formattedContext: 'generated summary',
      });
      mockPrisma.graphCommunity.findMany.mockResolvedValueOnce([
        { id: 'comm-1', title: '权限体系', entityIds: ['e1', 'e2'] },
      ]);
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([
        { id: 'e1', name: '鉴权中台', type: 'system' },
        { id: 'e2', name: '数据访问网关', type: 'system' },
      ]);

      const plan = await service.planDriftQueries(['kb-1'], '权限架构如何运行', { maxProbes: 1 });
      expect(plan.probes).toEqual(['权限体系 鉴权中台']);
      expect(plan.communityIds).toEqual(['comm-1']);
      expect(plan.seedEntities).toContain('鉴权中台');
      expect(plan.probes.join(' ')).not.toContain('generated summary');
    });
  });

  describe('searchRelatedChunkIds (graph retrieval arm)', () => {
    it('ranks chunks by relation weight and records the hop distance', async () => {
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([
        {
          id: 'e1',
          name: '值乘制度',
          outgoingRelations: [{ targetId: 'e2' }],
          incomingRelations: [],
        },
      ]);
      // First call = relations of the seed entities, second = 2-hop relations.
      mockPrisma.graphRelation.findMany
        .mockResolvedValueOnce([
          { weight: 3, provenance: [{ chunkId: 'c-strong', documentId: 'd1' }] },
          { weight: 1, provenance: [{ chunkId: 'c-weak', documentId: 'd1' }, { chunkId: 'c-strong', documentId: 'd1' }] },
        ])
        .mockResolvedValueOnce([{ weight: 2, provenance: [{ chunkId: 'c-second-hop', documentId: 'd2' }] }]);

      const hits = await service.searchRelatedChunkIds(['kb-1'], '值乘制度怎么规定的', 10);

      expect(hits.map((h) => h.chunkId)).toEqual(['c-strong', 'c-second-hop', 'c-weak']);
      expect(hits[0]).toMatchObject({ documentId: 'd1', score: 4, hops: 1 });
      expect(hits[1]).toMatchObject({ documentId: 'd2', hops: 2 });
    });

    it('returns nothing when the question mentions no known entity', async () => {
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([]);
      await expect(service.searchRelatedChunkIds(['kb-1'], '完全无关的问题', 10)).resolves.toEqual([]);
    });
  });
});
