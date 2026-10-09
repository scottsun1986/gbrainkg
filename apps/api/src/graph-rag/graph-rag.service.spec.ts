import { GraphRagService } from './graph-rag.service';
import { entityIdentityKey } from './graph-identity';

const mockPrisma: any = {
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

  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));

describe('GraphRagService', () => {
  let service: GraphRagService;

  // These cases assert the *legacy* full-scan rebuild path. Jest loads the
  // developer's apps/api/.env, so a local CORE_GRAPH_INCREMENTAL_ENABLED=1 made
  // scheduleCommunityRebuild take the incremental branch, which requires an
  // explicit worker identity in the request context and threw before the scan
  // under test. Pin the flag instead of depending on the machine's .env: the
  // incremental branch has its own coverage in incremental-projection.spec.ts.
  const originalIncremental = process.env.CORE_GRAPH_INCREMENTAL_ENABLED;
  const originalAuth = process.env.CORE_AUTH_ENFORCE;
  beforeAll(() => {
    process.env.CORE_GRAPH_INCREMENTAL_ENABLED = '0';
    process.env.CORE_AUTH_ENFORCE = '0';
  });
  afterAll(() => {
    if (originalAuth === undefined) delete process.env.CORE_AUTH_ENFORCE;
    else process.env.CORE_AUTH_ENFORCE = originalAuth;
    if (originalIncremental === undefined) delete process.env.CORE_GRAPH_INCREMENTAL_ENABLED;
    else process.env.CORE_GRAPH_INCREMENTAL_ENABLED = originalIncremental;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GraphRagService();
  });

  describe('entityIdentityKey (F05)', () => {
    it('normalizes the label but keeps the kind in the identity', () => {
      expect(entityIdentityKey(' 数据 平台 ', 'system')).toBe('数据 平台|system');
      expect(entityIdentityKey('RAGFlow', 'system')).toBe('ragflow|system');
      expect(entityIdentityKey('RAGFlow', 'organization')).not.toBe(entityIdentityKey('RAGFlow', 'system'));
      expect(entityIdentityKey('RAGFlow', '')).toBe('ragflow|concept');
    });
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
        .mockResolvedValueOnce({ id: 'ent-1', name: '系统A', entityKey: '系统a|system' })
        .mockResolvedValueOnce({ id: 'ent-2', name: '服务B', entityKey: '服务b|system' });

      // Entities are upserted with one batched statement that returns ids.
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'ent-1', name: '系统A', entityKey: '系统a|system' },
          { id: 'ent-2', name: '服务B', entityKey: '服务b|system' },
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
      // Identity is (normalized name, type), not the bare name (F05).
      expect(entitySql).toContain('ON CONFLICT ("kbId", "entityKey") DO UPDATE');
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
          { id: 'ent-1', name: '系统A', entityKey: '系统a|system' },
          { id: 'ent-2', name: '服务B', entityKey: '服务b|system' },
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
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'ent-1', name: '系统A', entityKey: '系统a|system' }]);
      await service.persistGraphElements('kb-1', {
        entities: [{ name: '系统A', type: 'system', sourceDocId: 'doc-2' }],
        relations: [],
      });

      const provenanceCall = mockPrisma.$executeRaw.mock.calls.find(
        (call: any[]) => (call[0] as TemplateStringsArray).join(' ').includes('jsonb_to_recordset'),
      );
      expect(provenanceCall).toBeDefined();
      const sql = provenanceCall![0] as TemplateStringsArray;
      expect(sql.join(' ')).toContain('jsonb_to_recordset');
      expect(provenanceCall).toContain(
        JSON.stringify([{ id: 'ent-1', docId: 'doc-2' }]),
      );
    });

    const sqlOf = (strings: any): string => Array.isArray(strings) ? strings.join(' ') : String(strings);

    it('creates separate identities for same-name entities of different kinds (F05)', async () => {
      mockPrisma.$queryRaw.mockImplementation(async (strings: any) => {
        const sql = sqlOf(strings);
        if (sql.includes('"GraphEntityAlias"')) return [];
        if (sql.includes('similarity(')) return [];
        if (sql.includes('INSERT INTO "GraphEntity"')) return [
          { id: 'ent-sys', name: '同名实体', entityKey: '同名实体|system' },
          { id: 'ent-org', name: '同名实体', entityKey: '同名实体|organization' },
        ];
        return [];
      });
      const res = await service.persistGraphElements('kb-1', {
        entities: [
          { name: '同名实体', type: 'system' },
          { name: '同名实体', type: 'organization' },
        ],
        relations: [],
      });
      expect(res.entityCount).toBe(2);
      const upsertCall = mockPrisma.$queryRaw.mock.calls.find((call: any[]) =>
        Array.isArray(call[0]) && call[0].join(' ').includes('INSERT INTO "GraphEntity"'));
      const payload = upsertCall!.find((value: any) => typeof value === 'string' && value.includes('|system'));
      const rows = JSON.parse(payload);
      mockPrisma.$queryRaw.mockReset();
      expect(rows.map((row: any) => row.entityKey).sort())
        .toEqual(['同名实体|organization', '同名实体|system']);
    });

    it('never folds a high-similarity surface form across entity kinds (F05)', async () => {
      mockPrisma.$queryRaw.mockImplementation(async (strings: any) => {
        const sql = sqlOf(strings);
        if (sql.includes('"GraphEntityAlias"')) return [];
        if (sql.includes('similarity(')) return [
          { incoming: '数据平台系统', canonical: '数据平台', canonicalType: 'organization', similarity: 0.97 },
        ];
        if (sql.includes('INSERT INTO "GraphEntity"')) return [
          { id: 'ent-sys', name: '数据平台系统', entityKey: '数据平台系统|system' },
        ];
        return [];
      });
      await service.persistGraphElements('kb-1', {
        entities: [{ name: '数据平台系统', type: 'system' }],
        relations: [],
      });
      const upsertCall = mockPrisma.$queryRaw.mock.calls.find((call: any[]) =>
        Array.isArray(call[0]) && call[0].join(' ').includes('INSERT INTO "GraphEntity"'));
      const payload = upsertCall!.find((value: any) => typeof value === 'string' && value.includes('|system'));
      const rows = JSON.parse(payload);
      mockPrisma.$queryRaw.mockReset();
      expect(rows[0].name).toBe('数据平台系统');
      expect(rows[0].entityKey).toBe('数据平台系统|system');
      const aliasWrite = mockPrisma.$executeRaw.mock.calls.find((call: any[]) =>
        Array.isArray(call[0]) && call[0].join(' ').includes('INSERT INTO "GraphEntityAlias"'));
      expect(aliasWrite).toBeUndefined();
    });

    it('records accepted aliases in the reviewable ledger with evidence (F05)', async () => {
      mockPrisma.$queryRaw.mockImplementation(async (strings: any) => {
        const sql = sqlOf(strings);
        if (sql.includes('"GraphEntityAlias"')) return [];
        if (sql.includes('similarity(')) return [
          { incoming: '数据平台系统', canonical: '数据平台系统架构', canonicalType: 'system', similarity: 0.95 },
        ];
        if (sql.includes('INSERT INTO "GraphEntity"')) return [
          { id: 'ent-canonical', name: '数据平台系统架构', entityKey: '数据平台系统架构|system' },
        ];
        return [];
      });
      await service.persistGraphElements('kb-1', {
        entities: [{ name: '数据平台系统', type: 'system' }],
        relations: [],
      });
      mockPrisma.$queryRaw.mockReset();
      const aliasWrite = mockPrisma.$executeRaw.mock.calls.find((call: any[]) =>
        Array.isArray(call[0]) && call[0].join(' ').includes('INSERT INTO "GraphEntityAlias"'));
      expect(aliasWrite).toBeDefined();
      const payload = aliasWrite!.find((value: any) => typeof value === 'string' && value.startsWith('[{'));
      expect(JSON.parse(payload)).toEqual([
        expect.objectContaining({
          entityId: 'ent-canonical',
          alias: '数据平台系统',
          evidence: expect.objectContaining({ method: 'similarity', similarity: 0.95 }),
        }),
      ]);
    });

    it('surfaces relation persistence failures so enrichment can retry', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'ent-1', name: '系统A', entityKey: '系统a|system' },
          { id: 'ent-2', name: '服务B', entityKey: '服务b|system' },
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

  describe('scheduleCommunityRebuild (coalesced per-KB rebuild)', () => {
    it('enqueues a single deduplicated delayed job instead of rebuilding inline', async () => {
      const add = jest.fn().mockResolvedValue({ id: 'job-1' });
      // @ts-expect-error optional injection
      const queued = new GraphRagService(undefined, undefined, { add });
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([]);

      await queued.scheduleCommunityRebuild('kb-1');

      expect(add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = add.mock.calls[0];
      expect(name).toBe('rebuild');
      expect(payload).toEqual({ kbId: 'kb-1' });
      // Same jobId deduplicates a burst of per-document triggers in Redis.
      expect(opts.jobId).toBe('graph-community-kb-1');
      expect(opts.delay).toBeGreaterThanOrEqual(0);
      // The full-KB scan must NOT have run inline.
      expect(mockPrisma.graphEntity.findMany).not.toHaveBeenCalled();
    });

    it('falls back to an inline rebuild when no queue is assembled', async () => {
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([]);
      await service.scheduleCommunityRebuild('kb-1');
      expect(mockPrisma.graphEntity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { kbId: 'kb-1' } }),
      );
    });

    it('falls back to an inline rebuild when the queue errors', async () => {
      const add = jest.fn().mockRejectedValue(new Error('redis down'));
      // @ts-expect-error optional injection
      const broken = new GraphRagService(undefined, undefined, { add });
      mockPrisma.graphEntity.findMany.mockResolvedValueOnce([]);
      await broken.scheduleCommunityRebuild('kb-1');
      expect(mockPrisma.graphEntity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { kbId: 'kb-1' } }),
      );
    });
  });
});
