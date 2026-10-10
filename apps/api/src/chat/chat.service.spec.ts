import { getRequestContext } from '../observability/request-context';
import { kbMetaCache } from '../retrieval/kb-intent-router';
import { TableEvidenceService } from '../retrieval/table-evidence.service';
import { countTables } from './table-count';
import { Test, TestingModule } from "@nestjs/testing";
import {
  ChatService,
  deterministicChunkCap,
  hasPolarityConflict,
  isStrongNameEntity,
  publicSearchResult,
  smartTruncateChunkText,
  statementSupportedBy,
  truncateChunkToTokenBudget,
} from "./chat.service";
import { PermissionService } from "../permission/permission.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { BrainScopeService } from "../brain-compiler/brain-scope.service";
import { lastValueFrom, toArray } from "rxjs";
import { GraphRagService } from "../graph-rag/graph-rag.service";
import { ModelConfigService } from "../model-config.service";
import { estimateTokens } from "./context-budget";
import { isStructuralHeadingLine, isTableSyntaxLine } from './chat.service';
import { isBlockLevelStart } from './chat.service';

const mockGraphRag = {
  searchLocalGraph: jest.fn().mockResolvedValue({
    entities: [{ name: "withdrawn-document" }], relations: [],
    formattedContext: "UNVERIFIED_WITHDRAWN_GRAPH_SECRET",
  }),
  searchGlobalCommunities: jest.fn().mockResolvedValue({
    communities: [], formattedContext: "UNVERIFIED_WITHDRAWN_GRAPH_SECRET",
  }),
  planDriftQueries: jest.fn().mockResolvedValue({ probes: [], communityIds: [], seedEntities: [] }),
};

// Mocks
const mockPermissionService = {
  getVisibleKnowledgeBases: jest.fn(),
};

const mockCompilerService = {
  triggerLazyCompileAndWait: jest.fn(),
  ensureUserBrainRepo: jest.fn(),
  syncUserBrainRepo: jest.fn().mockResolvedValue(undefined),
};

const mockGbrainQuery = jest.fn().mockResolvedValue({
  topics: ["数据合规"],
  answer: "Compiled truth",
  citations: [
    {
      topic: "数据合规",
      docId: "doc-1",
      docTitle: "规则.md",
      snippet: "Compiled truth",
      score: 0.9,
    },
  ],
  reranked: true,
});

const mockPrisma: any = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
  $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  brainRepo: {
    findUnique: jest.fn(),
  },
  brainTopic: {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  },
  document: {
    findMany: jest.fn(),
  },
  message: {
    findMany: jest.fn(),
  },
  chunk: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  brainDerivedPage: {
    findMany: jest.fn().mockResolvedValue([]),
  },

  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};

jest.mock("@prisma/client", () => ({
  ...jest.requireActual("@prisma/client"),
  PrismaClient: jest.fn().mockImplementation(() => new Proxy(mockPrisma, {
    get(target, property) {
      if (property !== 'document') return Reflect.get(target, property);
      return { ...target.document, findMany: (args: any) => {
        // Ordinary source fixtures have no QA authority rows. Preserve live
        // member replacement for count/enumeration tests and ACL race reads.
        if (args.where?.sourceType === 'qa' || args.where?.AND?.some((part: any) => part.sourceType === 'qa')) return Promise.resolve([]);
        return target.document.findMany(args);
      } };
    },
  })),
}));

jest.mock("@llmwiki/gbrain-adapter", () => ({
  BrainRepoAdapter: jest.fn().mockImplementation(() => ({
    query: mockGbrainQuery,
    queryMany: mockGbrainQuery,
    isSourceMaterialized: jest.fn().mockResolvedValue(false),
  })),
}));

describe("ChatService", () => {
  jest.setTimeout(15000);
  let service: ChatService;
  afterEach(() => {
    delete process.env.RETRIEVAL_ARM_POLICY;
    delete process.env.RETRIEVAL_SIBLING_EDITION_ALIGN;
  });

  it('does not turn a cancelled rewrite into a fallback query', async () => {
    const isolated = new ChatService({} as any, {} as any, {} as any);
    const controller = new AbortController();
    controller.abort();
    await expect((isolated as any).rewriteQueryForRetrieval('question', [], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts in-flight processing when the subscriber disconnects', async () => {
    const isolated = new ChatService({} as any, {} as any, {} as any);
    let captured: AbortSignal | undefined;
    jest.spyOn(isolated as any, 'processChat').mockImplementation((...args: any[]) => {
      captured = args[6];
      return new Promise<void>(resolve => captured!.addEventListener('abort', () => resolve(), { once: true }));
    });
    const stream = await isolated.handleChatStream('user', 'question');
    const subscription = stream.subscribe();
    await new Promise(resolve => setImmediate(resolve));
    expect(captured?.aborted).toBe(false);
    subscription.unsubscribe();
    expect(captured?.aborted).toBe(true);
  });

  beforeEach(async () => {
    process.env.RETRIEVAL_ARM_POLICY = "chunk_first";
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: GraphRagService, useValue: mockGraphRag },
        { provide: PermissionService, useValue: mockPermissionService },
        { provide: BrainCompilerService, useValue: mockCompilerService },
        {
          provide: BrainScopeService,
          useValue: { resolveUserScope: jest.fn().mockResolvedValue({ fingerprint: "test-scope", sourceKeys: [] }) },
        },
        {
          provide: ModelConfigService,
          useValue: {
            getDefault: jest.fn().mockResolvedValue(null),
            applyRuntimeConfig: jest.fn().mockResolvedValue(undefined),
            getRuntimeStatus: jest.fn().mockResolvedValue({ routes: {}, gbrain: {} }),
            getLlmChatConfig: jest.fn().mockImplementation(async () => {
              if (!process.env.DEEPSEEK_API_KEY) return null;
              return {
                baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
                apiKey: process.env.DEEPSEEK_API_KEY,
                modelName: process.env.LLM_MODEL || "test-model",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
              };
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    jest.clearAllMocks();
  });

  it('filters inventory and fallback search results by document ACL before returning them', async () => {
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'public-doc', kbId: 'kb-1', aclMode: 'inherit', lifecycleStatus: 'active' },
      { id: 'restricted-doc', kbId: 'kb-1', aclMode: 'inherit', lifecycleStatus: 'active' },
    ]);
    jest.spyOn((service as any).documentAclService, 'filterReadableDocuments')
      .mockResolvedValue(new Set(['public-doc']));
    const results = await (service as any).filterSearchResultsForUser('user-1', ['kb-1'], [
      { documentId: 'public-doc', evidence: 'visible' },
      { documentId: 'restricted-doc', evidence: 'secret' },
    ]);
    expect(results).toEqual([{ documentId: 'public-doc', evidence: 'visible' }]);
  });

  it.each(['示例杯团队打分，研发超过90的有几支', '示例杯团队相关研发打分超过90的有几支'])('counts a complete named table with typed filters and keeps original citations: %s', async (question) => {
    jest.spyOn((service as any).modelConfigService, 'getLlmChatConfig').mockResolvedValue({baseUrl:'https://model.test/v1',modelName:'test-model',headers:{'Content-Type':'application/json'}});
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([{id:'table-doc',kbId:'kb-1',aclMode:'inherit',title:'示例杯团队打分表.md',version:1,activeVersionId:'v1'}]);
    const oldChunks = mockPrisma.chunk;
    const markdown = '| 名称 | 部门 | 分数 |\n| --- | --- | --- |\n| A | 研发 | 90 |\n| B | 研发 | 95 |\n| C | 运维 | 99 |';
    mockPrisma.chunk = {count:jest.fn().mockResolvedValue(1),findMany:jest.fn().mockResolvedValue([{id:'table-row',documentId:'table-doc',kbId:'kb-1',ord:0,content:markdown}])};
    const source = jest.spyOn(TableEvidenceService.prototype, 'readPublishedTables').mockResolvedValue({tables:countTables(markdown),sourceHash:'hash',versionId:'v1'});
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({table:0,filters:[{column:1,operator:'eq',value:'研发'},{column:2,operator:'gt',value:'90'}]})}}]})});
    try {
      const stream = await service.handleChatStream('user-1',question);
      const events = await lastValueFrom(stream.pipe(toArray()));
      const answer = events.filter(e=>(e.data as any).type==='delta').map(e=>(e.data as any).content).join('');
      expect(answer).toContain('**1 条**'); expect(answer).toContain('名称：B');
      expect(answer).not.toContain('名称：A'); expect(answer).not.toContain('名称：C');
      expect(source).toHaveBeenCalledWith('user-1','table-doc','v1');
      expect(events.some(e=>(e.data as any).type==='citation')).toBe(true);
    } finally {global.fetch=originalFetch;source.mockRestore();mockPrisma.chunk=oldChunks;}
  });

  it('enumerates all source chunks without invoking search or generation', async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'outline-doc', kbId: 'kb-1', aclMode: 'inherit', title: '指南.docx', version: 1, kb: { name: '知识库' } },
    ]);
    const oldChunks = mockPrisma.chunk;
    mockPrisma.chunk = { count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([
      { id: 'first', documentId: 'outline-doc', kbId: 'kb-1', ord: 0, content: '\\## 第一章 总则' },
      { id: 'last', documentId: 'outline-doc', kbId: 'kb-1', ord: 50, content: '\\## 第八章 附则' },
    ]) };
    const retrieval = jest.spyOn((service as any).retrievalArms, 'searchChunksFallback');
    try {
      const stream = await service.handleChatStream('user-1', '请列出《指南》的全部章名');
      const events = await lastValueFrom(stream.pipe(toArray()));
      const answer = events.filter(e => (e.data as any).type === 'delta').map(e => (e.data as any).content).join('');
      expect(answer).toContain('第一章 总则 [1]'); expect(answer).toContain('第八章 附则 [1]');
      expect(events.some(e => (e.data as any).type === 'error')).toBe(false);
      expect(events.some(e => (e.data as any).type === 'done')).toBe(true);
      expect(retrieval).not.toHaveBeenCalled();
      expect(mockPrisma.chunk.findMany.mock.calls[0][0].where.kbId).toEqual({ in: ['kb-1'] });
    } finally { mockPrisma.chunk = oldChunks; retrieval.mockRestore(); }
  });

  it('does not disclose headings from a named document denied by document ACL', async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'denied-doc', kbId: 'kb-1', aclMode: 'restricted', title: '指南.docx', version: 1 },
    ]);
    const oldChunks = mockPrisma.chunk;
    mockPrisma.chunk = { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([
      { id: 'secret', documentId: 'denied-doc', kbId: 'kb-1', ord: 0, content: '## 第一章 SECRET_HEADING' },
    ]) };
    jest.spyOn((service as any).documentAclService, 'filterReadableDocuments').mockResolvedValue(new Set());
    try {
      const stream = await service.handleChatStream('user-1', '请列出《指南》的全部章名');
      const events = await lastValueFrom(stream.pipe(toArray()));
      expect(JSON.stringify(events)).not.toContain('SECRET_HEADING');
      expect(events.filter(e => (e.data as any).type === 'citation')).toHaveLength(0);
    } finally { mockPrisma.chunk = oldChunks; }
  });

  it('does not claim a full outline when the source scan is truncated', async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'outline-doc', kbId: 'kb-1', aclMode: 'inherit', title: '指南.docx', version: 1 },
    ]);
    const oldChunks = mockPrisma.chunk;
    mockPrisma.chunk = { count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([
      { id: 'first', documentId: 'outline-doc', kbId: 'kb-1', ord: 0, content: '## 第一章 总则' },
    ]) };
    try {
      const stream = await service.handleChatStream('user-1', '请列出《指南》的全部章名');
      const events = await lastValueFrom(stream.pipe(toArray()));
      const answer = events.filter(e => (e.data as any).type === 'delta').map(e => (e.data as any).content).join('');
      expect(answer).toContain('无法回答全部章名'); expect(answer).not.toContain('第一章');
    } finally { mockPrisma.chunk = oldChunks; }
  });

  it.each([false, true])('chunks_only makes zero engine calls with DB evidence=%s', async (hasEvidence) => {
    process.env.RETRIEVAL_ARM_POLICY = 'chunks_only';
    jest.spyOn((service as any).modelConfigService, 'getLlmChatConfig').mockResolvedValue(null);
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([{ id: 'doc-1', kbId: 'kb-1', aclMode: 'inherit', version: 1 }]);
    jest.spyOn((service as any).retrievalArms, 'searchChunksFallback').mockResolvedValue(hasEvidence
      ? [{ id: 'chunk-1', documentId: 'doc-1', kbId: 'kb-1', version: 1, evidence: 'Authorized source facts', title: 'Rules' }] : []);
    const events = await lastValueFrom((await service.handleChatStream('user-1', 'source query', ['kb-1'])).pipe(toArray()));
    expect(events.some(e => (e.data as any).type === 'error')).toBe(false);
    expect(mockGbrainQuery).not.toHaveBeenCalled();
    expect(events.some(e => (e.data as any).type === 'done')).toBe(true);
  });

  it("should stream chat and trigger lazy compile if topic is dirty", async () => {
    // This tests compilation/evidence streaming, not a live model gateway.
    jest.spyOn((service as any).modelConfigService, 'getLlmChatConfig').mockResolvedValue(null);
    // 权限校验 mock
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);

    // Brain repo mock
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md" },
    ]);

    // 模拟主题是 dirty 的，触发懒编译（命中主题改为一次性 findMany 批量查询）
    mockPrisma.brainTopic.findMany.mockResolvedValueOnce([
      { topicSlug: "数据合规", compileStatus: "dirty" },
    ]);
    mockCompilerService.triggerLazyCompileAndWait.mockResolvedValue(undefined);

    const stream$ = await service.handleChatStream("user-1", "测试问题");
    const events = await lastValueFrom(stream$.pipe(toArray()));

    // 验证懒编译被调用（第三个参数为受 deadline 约束的等待上限）
    expect(mockCompilerService.triggerLazyCompileAndWait).toHaveBeenCalledWith(
      "user-1",
      "数据合规",
      expect.any(Number),
    );

    // 验证流式事件输出
    expect(events.filter((e) => (e.data as any).type === "error")).toEqual([]);
    expect(events.some((e) => (e.data as any).type === "meta")).toBeTruthy();
    expect(events.some((e) => (e.data as any).type === "delta")).toBeTruthy();
    expect(
      events.some((e) => (e.data as any).type === "citation"),
    ).toBeTruthy();
    expect(events.some((e) => (e.data as any).type === "done")).toBeTruthy();
  });

  it('injects a newly compiled authorized document and counts only inserted cards', async () => {
    jest.spyOn((service as any).modelConfigService, 'getLlmChatConfig').mockResolvedValue(null);
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    const original = { id: 'doc-1', kbId: 'kb-1', aclMode: 'inherit', version: 1, title: '规则.md' };
    const fresh = { id: 'new-doc', kbId: 'kb-1', aclMode: 'inherit', version: 1, title: '数据合规',
      chunks: [{ ord: 0, content: '新编译的授权原文条款。' }], kb: { name: 'KB' } };
    mockPrisma.document.findMany.mockImplementation(async (args: any) => args.include?.chunks ? [fresh] : [original, fresh]);
    mockPrisma.brainTopic.findMany.mockResolvedValueOnce([{ topicSlug: '数据合规', compileStatus: 'dirty' }]);
    mockCompilerService.triggerLazyCompileAndWait.mockResolvedValue(undefined);
    const events = await lastValueFrom((await service.handleChatStream('user-1', '测试问题', ['kb-1'])).pipe(toArray()));
    const node = events.find(e => (e.data as any).type === 'trace' && (e.data as any).node.id === 'lazy_compile' && (e.data as any).node.status === 'success');
    expect((node?.data as any).node.details.injected).toBe(1);
    expect(events.filter(e => (e.data as any).type === 'citation').map(e => (e.data as any).timeline_entry.document_id)).toContain('new-doc');
  });

  it('captures source dependencies before returning evidence without a model', async () => {
    const previous = process.env.CORE_AUTH_ENFORCE;
    process.env.CORE_AUTH_ENFORCE = '1';
    jest.spyOn((service as any).modelConfigService, 'getLlmChatConfig').mockResolvedValue(null);
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'doc-1', kbId: 'kb-1', aclMode: 'inherit', title: '规则.md', version: 1,
        activeVersionId: null, contentHash: 'hash', effectiveTo: null },
    ]);
    mockPrisma.$queryRaw.mockImplementation(async (sql: any) => String(sql).includes('AuthorizationState')
      ? [{ revision: 1n, policyVersion: 'core-auth-v1', active: true, expiresAt: null }] : []);
    jest.spyOn((service as any).retrievalArms, "searchChunksFallback").mockResolvedValue([{ id: "chunk-1", documentId: "doc-1", kbId: "kb-1", version: 1, evidence: "Compiled truth", title: "规则.md" }]);
    jest.spyOn((service as any).fusionRerank, "rerankPool").mockImplementation(async (_q: any, result: any) => ({ ...result, citations: result.citations.map((c: any) => ({ ...c, calibratedProbability: 0.9, scoreSource: "rerank" })) }));
    try {
      const stream = await service.handleChatStream('user-1', '测试问题');
      const events = await lastValueFrom(stream.pipe(toArray()));
      const done = events.find(event => (event.data as any).type === 'done');
      expect((done?.data as any).dependency_manifest).toEqual([
        { documentId: 'doc-1', versionId: null, number: 1, sourceHash: 'hash', effectiveTo: null },
      ]);
      expect(events.some(event => (event.data as any).type === 'citation')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CORE_AUTH_ENFORCE;
      else process.env.CORE_AUTH_ENFORCE = previous;
      mockPrisma.$queryRaw.mockReset();
    }
  });

  it('turns graph relations into ACL-checked source citations instead of graph prose', async () => {
    // P2-3 routing gates the graph probe by query shape; this contract test
    // pins the graph-binding behaviour itself, so it opts into GRAPHRAG_ROUTE=always.
    const previousGraphRoute = process.env.GRAPHRAG_ROUTE;
    process.env.GRAPHRAG_ROUTE = 'always';
    const chunkId = '11111111-1111-4111-8111-111111111111';
    jest.spyOn((service as any).retrievalArms, 'searchChunksFallback').mockResolvedValue([]);
    mockGbrainQuery.mockResolvedValueOnce({ citations: [], topics: [], answer: '', reranked: true });
    mockGraphRag.searchLocalGraph.mockResolvedValueOnce({
      entities: [],
      relations: [{
        source: '系统A', target: '制度B', relationType: 'references', weight: 1,
        snippet: 'GRAPH_ONLY_PROSE',
        provenance: [{ documentId: '22222222-2222-4222-8222-222222222222', chunkId }],
      }],
      formattedContext: 'GRAPH_ONLY_PROSE',
    });
    mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      id: chunkId,
      documentId: '22222222-2222-4222-8222-222222222222',
      kbId: '33333333-3333-4333-8333-333333333333',
      ord: 2,
      content: '制度B原文明确说明系统A引用该制度。',
      metadata: { page_no: 4 },
      docTitle: '制度B.md',
      docVersion: 3,
    }]);

    const hits = await (service as any).retrieveHopProbes(
      ['33333333-3333-4333-8333-333333333333'],
      ['gbrain://source/test'],
      undefined,
      ['系统A 制度B'],
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: chunkId,
      context: '制度B原文明确说明系统A引用该制度。',
      graphProvenanceBound: true,
      docTitle: '制度B.md',
    });
    expect(hits[0].context).not.toContain('GRAPH_ONLY_PROSE');
    if (previousGraphRoute === undefined) delete process.env.GRAPHRAG_ROUTE;
    else process.env.GRAPHRAG_ROUTE = previousGraphRoute;
  });

  it("should preserve conversation context without sending stale assistant turns as live messages", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md" },
    ]);
    mockPrisma.message.findMany.mockResolvedValue([
      { role: "user", content: "当前问题" },
      { role: "assistant", content: "上一轮回答" },
      { role: "user", content: "上一轮问题" },
    ]);
    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: '{"query":"当前问题","breadth":false}' } },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
          }),
        },
      });
    (global as any).fetch = fetchMock;

    try {
      const stream$ = await service.handleChatStream(
        "user-1",
        "当前问题",
        ["kb-1"],
        "conversation-1",
      );
      await lastValueFrom(stream$.pipe(toArray()));
      const requestBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      const data = JSON.parse(requestBody.messages[1].content);
      expect(data.question).toBe("当前问题");
      expect(data.conversationForDisambiguation).toContain("上一轮问题");
      expect(data.conversationForDisambiguation).toContain("上一轮回答");
      expect(requestBody.messages[0].content).not.toContain("上一轮问题");
      expect(requestBody.messages[0].content).toContain("【参考知识库资料】");
      expect(requestBody.messages[0].content).not.toContain("UNVERIFIED_WITHDRAWN_GRAPH_SECRET");
      expect(mockGraphRag.searchLocalGraph).not.toHaveBeenCalled();
      expect(mockGraphRag.searchGlobalCommunities).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("should retain the original wording while applying the broad retrieval profile on a fresh turn", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "gbrain://source/test",
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md" },
    ]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.brainTopic.findUnique.mockResolvedValue(null);
    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"query":"企业研发管理规范全部条款数量","breadth":true,"operation":"query"}',
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
          }),
        },
      });

    try {
      const stream$ = await service.handleChatStream(
        "user-1",
        "这个规范一共有多少条款",
      );
      await lastValueFrom(stream$.pipe(toArray()));
      expect(mockGbrainQuery).toHaveBeenCalledWith(
        "gbrain://source/test",
        "这个规范一共有多少条款",
        expect.objectContaining({ breadth: true, operation: "query", signal: expect.any(AbortSignal) }),
      );
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("selectEvidence drops low-relevance singleton distractors on focused retrieval", () => {
    const result = (service as any).selectEvidence({
      citations: [
        { topic: "目标制度", relevanceScore: 0.9, context: "目标内容" },
        { topic: "无关制度", relevanceScore: 0.05, context: "无关内容" },
      ],
      topics: ["目标制度", "无关制度"],
      answer: "目标内容\n\n无关内容",
      reranked: true,
    }, { breadth: false, tokenBudget: 12000 });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].topic).toBe("目标制度");
    expect(result.evidenceSelection.removed).toBe(1);
  });

  it("selectEvidence enforces per-sub-question coverage for compound questions", () => {
    // Hop 1 evidence dominates on relevance; hop 2 (夏天/夏令时) would be
    // dropped by the global floor — the coverage quota must inject it.
    const result = (service as any).selectEvidence({
      citations: [
        { id: "c1", topic: "设备表格", relevanceScore: 0.95, context: "EQ-0077 智能巡检机器人 巡检周期 30天 班组C 指标权重" },
        { id: "c2", topic: "考勤作息", relevanceScore: 0.10, subQueryOrigin: "员工夏天几点上班", context: "夏令时作息时间安排 上午 08:30 上班 考勤管理规定" },
        { id: "c3", topic: "无关", relevanceScore: 0.02, context: "无关内容占位文本" },
      ],
      reranked: true,
    }, { breadth: false, tokenBudget: 12000, subQueries: ["EQ-0077 的巡检周期是多少天", "员工夏天几点上班"] });

    const ids = result.citations.map((c: any) => c.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2"); // hop-2 group injected despite low global relevance
    expect(ids).not.toContain("c3");
    expect(result.evidenceSelection.subQueryInjected).toBeGreaterThanOrEqual(1);
  });

  it("selectEvidence keeps structural section groups whole even when members score lower", () => {
    const result = (service as any).selectEvidence({
      citations: [
        { topic: "章节标题", relevanceScore: 0.95, sectionGroup: "doc:1", context: "（四）完善创业服务保障" },
        { topic: "条款13", relevanceScore: 0.4, sectionGroup: "doc:1", context: "强化融资服务保障" },
        { topic: "条款15", relevanceScore: 0.2, sectionGroup: "doc:1", context: "深化国际交流合作" },
      ],
      reranked: true,
    }, { breadth: false, tokenBudget: 12000 });

    // The whole section survives as one atomic unit (3 members, one group).
    expect(result.citations).toHaveLength(3);
    expect(result.evidenceSelection.groups).toBe(1);
  });

  it("selectEvidence protects concrete table chunks from being displaced by doc summaries", () => {
    const tableText = "| 队伍编号 | 队伍名称 | 分数 |\n| 001 | 队伍A | 90 |\n| 002 | 队伍B | 88 |\n| 003 | 队伍C | 95 |";
    const summaryText = "【宏观摘要 · 全文】打分表.xlsx\n| 队伍编号 | 队伍名称 | 分数 |\n| 001 | 队伍A | 90 |";

    const result = (service as any).selectEvidence({
      citations: [
        {
          id: "summary-1",
          docId: "doc-table",
          docTitle: "打分表.xlsx · 全文摘要",
          relevanceScore: 0.90,
          context: summaryText,
          snippet: summaryText,
          evidence: summaryText,
          raptor: true,
          isSummary: true,
        },
        {
          id: "chunk-0",
          docId: "doc-table",
          docTitle: "打分表.xlsx",
          relevanceScore: 0.85,
          context: tableText,
          snippet: tableText,
          evidence: tableText,
        },
      ],
      reranked: true,
    }, { breadth: false, tokenBudget: 12000 });

    const ids = result.citations.map((c: any) => c.id);
    expect(ids).toContain("chunk-0");
  });

  it("augmentWithDocumentSummaries skips non-macro queries and spreadsheet documents", async () => {
    const mockRaptorService = {
      isEnabled: () => true,
      getDocumentSummaries: jest.fn().mockResolvedValue([
        { documentId: "doc-1", title: "打分表.xlsx", evidence: "宏观摘要", score: 0.9 },
      ]),
      getDocumentOutlines: jest.fn().mockResolvedValue([]),
    };
    (service as any).retrievalArms.raptorService = mockRaptorService;

    // Non-macro query should NOT augment summaries
    const res1 = await (service as any).augmentWithDocumentSummaries(
      { citations: [{ docId: "doc-1", docTitle: "打分表.xlsx", relevanceScore: 0.9 }] },
      ["kb-1"],
      "请问001队伍得了多少分",
      "factual",
    );
    expect(res1.citations).toHaveLength(1);
    expect(mockRaptorService.getDocumentSummaries).not.toHaveBeenCalled();

    // Macro query on spreadsheet should still be skipped
    const res2 = await (service as any).augmentWithDocumentSummaries(
      { citations: [{ docId: "doc-1", docTitle: "打分表.xlsx", relevanceScore: 0.9 }] },
      ["kb-1"],
      "请概述打分表.xlsx的总体结构",
      "global_synthesis",
    );
    expect(res2.citations).toHaveLength(1);
    expect(mockRaptorService.getDocumentSummaries).not.toHaveBeenCalled();
  });

  it("should not escalate a high-score weak-semantic hit", () => {
    const decision = (service as any).assessWeakEvidence({
      citations: [{ evidence: "weak_semantic", score: 0.925 }],
    }, false);

    expect(decision.shouldEscalate).toBe(false);
    expect(decision.weak).toBe(true);
    expect(decision.reason).toContain("交由证据门控验证");
  });

  it("should escalate a low-score weak-semantic hit", () => {
    const decision = (service as any).assessWeakEvidence({
      citations: [{ evidence: "weak_semantic", score: 0.52 }],
    }, false);

    expect(decision.shouldEscalate).toBe(true);
    expect(decision.scoreFloor).toBe(0.75);
  });

  it("should trust a high-confidence fallback rerank before expanding weak semantic evidence", () => {
    const decision = (service as any).assessWeakEvidence({
      citations: [{ evidence: "weak_semantic", score: 0.12, rerankScore: 0.93 }],
    }, false);

    expect(decision.shouldEscalate).toBe(false);
    expect(decision.topScore).toBe(0.93);
  });

  it("should use the separately calibrated fallback-rerank threshold", () => {
    expect((service as any).assessWeakEvidence({
      citations: [{ evidence: "weak_semantic", score: 0.12, rerankScore: 0.735 }],
    }, false)).toMatchObject({ shouldEscalate: false, scoreFloor: 0.70 });
    expect((service as any).assessWeakEvidence({
      citations: [{ evidence: "weak_semantic", score: 0.95, rerankScore: 0.69 }],
    }, false)).toMatchObject({ shouldEscalate: true, scoreFloor: 0.70 });
  });

  it("should use the original wording for a fresh conversation without an LLM rewrite", async () => {
    const originalFetch = global.fetch;
    (global as any).fetch = jest.fn();
    try {
      await expect((service as any).rewriteQueryForRetrieval("员工考勤办法第十条是什么内容", [
        { role: "user", content: "员工考勤办法第十条是什么内容" },
      ])).resolves.toEqual({
        query: "员工考勤办法第十条是什么内容",
        breadth: false,
        operation: "search",
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  it("should reserve private-memory recall for explicit personal or contextual requests", () => {
    expect((service as any).shouldLoadPersonalMemory("员工考勤办法第十条是什么内容", [
      { role: "user", content: "员工考勤办法第十条是什么内容" },
    ])).toBe(false);
    expect((service as any).shouldLoadPersonalMemory("我的账号是什么", [
      { role: "user", content: "我的账号是什么" },
    ])).toBe(true);
    expect((service as any).shouldLoadPersonalMemory("那个怎么处理", [
      { role: "user", content: "上一轮问题" },
      { role: "assistant", content: "上一轮回答" },
      { role: "user", content: "那个怎么处理" },
    ])).toBe(true);
  });

  it("should not escalate explicit evidence or an already broad query", () => {
    expect((service as any).assessWeakEvidence({
      citations: [{ evidence: "keyword_exact", score: 0.2 }],
    }, false).shouldEscalate).toBe(false);
    expect((service as any).assessWeakEvidence({
      citations: [{ evidence: "weak_semantic", score: 0.1 }],
    }, true).shouldEscalate).toBe(false);
  });

  it("should strip citations for documents that are revoked before emission", async () => {
    // A real state transition during generation, independent of how many
    // scoped QA/ACL lookups occur before the final output verification.
    process.env.RETRIEVAL_SIBLING_EDITION_ALIGN = "false";
    // 1. Initial layer permission check (retrieval time)
    mockPermissionService.getVisibleKnowledgeBases
      .mockResolvedValueOnce(["kb-1"]) // First call in processChat
      .mockResolvedValueOnce(["kb-1"]); // Second call in emitCitationsAndComplete

    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });

    let revoked = false;
    let readsAfterRevocation = 0;
    const source = { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md", version: 1,
      kb: { name: "知识库", type: "platform" } };
    mockPrisma.document.findMany.mockReset().mockImplementation(async (args: any) => {
      if (revoked) { readsAfterRevocation++; return []; }
      if (args.where?.supersedesDocumentId) return [];
      return [source];
    });

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const generationRead = jest.fn()
      .mockImplementationOnce(async () => {
        revoked = true; // grant removed during an actually consumed model stream
        // The sentence must overlap the citation evidence ("Compiled truth")
        // so it survives the grounding gate: this test targets the emit-time
        // ACL strip of a cited answer, not the refusal fallback (a marker-less
        // refusal now emits zero citations by contract — see
        // refusal-citation-output.spec.ts).
        return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Compiled truth[1]"}}]}\n\n') };
      })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest.fn().mockImplementation(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (!request.stream) return { ok: true, json: async () => ({
        choices: [{ message: { content: '{"query":"测试问题","breadth":false}' } }],
      }) };
      return { ok: true, body: { getReader: () => ({ read: generationRead,
        cancel: jest.fn().mockResolvedValue(undefined), releaseLock: jest.fn(),
      }) } };
    });
    (global as any).fetch = fetchMock;

    try {
      const stream$ = await service.handleChatStream("user-1", "测试问题", ["kb-1"]);
      const events = await lastValueFrom(stream$.pipe(toArray()));
      
      expect(generationRead).toHaveBeenCalled();
      expect(revoked).toBe(true);
      expect(readsAfterRevocation).toBeGreaterThan(0);

      // Verify citation event was stripped (not emitted)
      const citationEvents = events.filter((e) => (e.data as any).type === "citation");
      expect(citationEvents.length).toBe(0); // Should be empty because doc-1 was stripped

    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
  it("should detect version conflicts and include version details in timeline_entry", async () => {
    // Query-driven fixtures preserve the physical version for every ACL
    // refresh; version-family reads return both published same-title editions.
    process.env.RETRIEVAL_SIBLING_EDITION_ALIGN = "false";
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);

    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });

    const current = { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md", version: 2,
      kb: { name: "知识库", type: "platform" } };
    const sibling = { ...current, id: "doc-2", version: 3 };
    mockPrisma.document.findMany.mockReset().mockImplementation(async (args: any) => {
      if (args.where?.supersedesDocumentId) return [];
      if (args.select?.supersedesDocumentId && args.where?.OR) return [current, sibling];
      return [current];
    });

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          cancel: jest.fn().mockResolvedValue(undefined),
          releaseLock: jest.fn(),
          // The sentence overlaps the citation evidence ("Compiled truth") so
          // it survives the grounding gate and actually cites [1]: the
          // version-conflict metadata must reach the timeline_entry of a real
          // cited answer. (A marker-less refusal now emits zero citations by
          // contract — see refusal-citation-output.spec.ts.)
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Compiled truth[1]"}}]}\n\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });
    (global as any).fetch = fetchMock;

    try {
      const stream$ = await service.handleChatStream("user-1", "测试问题", ["kb-1"]);
      const events = await lastValueFrom(stream$.pipe(toArray()));
      
      const citationEvents = events.filter((e) => (e.data as any).type === "citation");
      expect(citationEvents.length).toBe(1);
      
      const timelineEntry = (citationEvents[0].data as any).timeline_entry;
      expect(timelineEntry.version).toBe(2);
      expect(timelineEntry.version_conflict).toMatchObject({
        hasConflict: true,
        currentVersion: 2,
        latestVersion: 3,
        allVersions: [3, 2],
      });
      expect(timelineEntry.preview_url).toBe("/api/v1/kbs/kb-1/documents/doc-1/preview-config");
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
      mockPrisma.document.findMany.mockReset(); // reset for next tests
    }
  });
  it("holds and drops streamed sentences that lack evidence support instead of showing them", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });

    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md", version: 1, kb: { name: "知识库", type: "platform" } },
    ]);

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          cancel: jest.fn().mockResolvedValue(undefined),
          releaseLock: jest.fn(),
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"这里是未经引用的第一句话。这里是毫无关联的第二句话。没有任何角标。"}}]}\n\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });
    (global as any).fetch = fetchMock;

    try {
      const stream$ = await service.handleChatStream("user-1", "测试问题", ["kb-1"]);
      const events = await lastValueFrom(stream$.pipe(toArray()));

      // Strict grounding gate: unsupported sentences are held and (with the
      // entailment judge unavailable here) dropped — never shown to the user.
      const deltas = events
        .filter((e) => (e.data as any).type === "delta")
        .map((e) => (e.data as any).content)
        .join("");
      expect(deltas).not.toContain("这里是未经引用的第一句话");
      expect(deltas).not.toContain("这里是毫无关联的第二句话");

      const gateEvents = events.filter((e) => (e.data as any).type === "trace" && (e.data as any).node.id === "grounding_gate");
      const gate = gateEvents[gateEvents.length - 1];
      expect(gate).toBeDefined();
      expect((gate.data as any).node.status).toBe("warning");
      expect((gate.data as any).node.details.dropped).toBeGreaterThanOrEqual(2);
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
      mockPrisma.document.findMany.mockReset();
    }
  });

  it('does not prepend a refusal when the only sentence is verified late', async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(['kb-1']);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'doc-1', kbId: 'kb-1', aclMode: 'inherit', title: '规则.md', version: 1 },
    ]);
    const originalFetch = global.fetch;
    const oldKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const judge = jest.spyOn(service as any, 'judgeEntailment').mockResolvedValue(new Set([0]));
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: { getReader: () => ({
      read: jest.fn().mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"这是经语义复核确认的回答内容。"}}]}\n\n',
      ) }).mockResolvedValueOnce({ done: true }),
      cancel: jest.fn().mockResolvedValue(undefined), releaseLock: jest.fn(),
    }) } });
    try {
      const events = await lastValueFrom((await service.handleChatStream('user-1', '测试问题', ['kb-1'])).pipe(toArray()));
      const answer = events.filter(e => (e.data as any).type === 'delta').map(e => (e.data as any).content).join('');
      expect(judge).toHaveBeenCalled();
      expect(answer).toContain('这是经语义复核确认的回答内容。');
      expect(answer).not.toContain('无法回答');
      expect(answer).not.toContain('未包含相关信息');
    } finally {
      global.fetch = originalFetch;
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
      judge.mockRestore();
    }
  });

  it("does not flag low coverage for a standard refusal answer", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md", version: 1, kb: { name: "知识库", type: "platform" } },
    ]);

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          cancel: jest.fn().mockResolvedValue(undefined),
          releaseLock: jest.fn(),
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已知知识库资料中未包含相关信息，无法回答该问题。"}}]}\n\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });

    try {
      const stream$ = await service.handleChatStream("user-1", "一个知识库不含的问题", ["kb-1"]);
      const events = await lastValueFrom(stream$.pipe(toArray()));
      const traceEvents = events.filter((e) => (e.data as any).type === "trace" && (e.data as any).node.id === "citation_validation");
      const finalTrace = traceEvents[traceEvents.length - 1];
      expect((finalTrace.data as any).node.summary).not.toContain("证据语义覆盖率偏低");
      expect((finalTrace.data as any).node.details.semanticCoverage.refusalExempt).toBe(true);
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
      mockPrisma.document.findMany.mockReset();
    }
  });

  it("searchKnowledgeForAgent returns structured citations for agent/MCP queries", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: "/tmp/repo" });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md", version: 1, qualityStatus: "passed" },
    ]);

    const result = await service.searchKnowledgeForAgent("user-1", "数据合规", ["kb-1"], 5);
    expect(result.success).toBe(true);
    expect(result.query).toBe("数据合规");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].documentId).toBe("doc-1");
    expect(result.results[0].previewUrl).toContain("/api/v1/kbs/kb-1/documents/doc-1/preview-config");
  });

  it('keeps every authorized KB in retrieval and passes routed KBs only as a priority hint (F02)', async () => {
    const kbs = ['kb-1', 'kb-2', 'kb-3', 'kb-4'];
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(kbs);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: '/tmp/repo' });
    // Pre-seed router metadata so the decision never depends on the DB fixture.
    kbMetaCache.set('kb-2', { id: 'kb-2', name: '人事规章', description: '年假与考勤', domainTerms: ['年假'] });
    for (const id of ['kb-1', 'kb-3', 'kb-4']) {
      kbMetaCache.set(id, { id, name: `通用资料库${id}`, description: '', domainTerms: [] });
    }
    mockPrisma.document.findMany.mockResolvedValue([
      { id: 'doc-1', kbId: 'kb-1', aclMode: 'inherit', title: '规则.md', version: 1, activeVersionId: 'v1', contentHash: 'hash' },
    ]);
    const fallback = jest.spyOn(service as any, 'searchChunksFallback').mockResolvedValue([
      { documentId: 'doc-1', kbId: 'kb-1', title: '规则.md', evidence: '可读证据', score: 0.9, previewUrl: null },
    ]);
    const poolAcl = jest.spyOn(service as any, 'filterQueryResultByCurrentPermission').mockImplementation(async (result: any) => result);
    const finalAcl = jest.spyOn(service as any, 'filterSearchResultsForUser').mockImplementation(async (_user: string, _scope: string[], results: any[]) => results);
    try {
      const result = await service.searchKnowledgeForAgent('user-1', '年假怎么申请', undefined, 5);
      expect(result.success).toBe(true);
      // The authorized scope is returned unchanged...
      expect(result.kbScope).toEqual(kbs);
      // ...every retrieval arm searched all four authorized KBs...
      const scopes = fallback.mock.calls.map((call: any[]) => call[0]);
      expect(scopes.length).toBeGreaterThan(0);
      for (const scopeArg of scopes) expect(scopeArg).toEqual(kbs);
      // ...and the routed KB is only a priority hint, never an exclusive filter.
      const priorityArgs = fallback.mock.calls.map((call: any[]) => call[5]).filter(Boolean);
      expect(priorityArgs.length).toBeGreaterThan(0);
      expect(priorityArgs[0]).toEqual(['kb-2']);
    } finally {
      fallback.mockRestore();
      poolAcl.mockRestore();
      finalAcl.mockRestore();
      kbMetaCache.clear();
    }
  });

  it("projects search hits without leaking internal source manifests or inventory scope", () => {
    const projected = publicSearchResult({ documentId: "doc-1", title: "T", evidence: "e",
      sourceManifest: [{ docId: "doc-1", version: 2 }], sourceDocumentIds: ["doc-1"],
      evidenceRefs: [{ versionId: "v2" }], inventory: true, inventoryScope: ["kb-1"] });
    expect(projected).toEqual({ documentId: "doc-1", title: "T", evidence: "e" });
    expect(projected).not.toHaveProperty("sourceManifest");
    expect(projected).not.toHaveProperty("inventoryScope");
  });

  it("runs final ACL verification after retrieval deadline exhaustion and stops further probes", async () => {
    const originalAdaptive = process.env.ADAPTIVE_RETRIEVAL_ENABLED;
    process.env.ADAPTIVE_RETRIEVAL_ENABLED = 'true';
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: "/tmp/repo" });
    const poolAcl = jest.spyOn(service as any, 'filterQueryResultByCurrentPermission').mockImplementation(async (result: any) => {
      expect(getRequestContext()?.userId).toBe('user-1');
      expect(getRequestContext()?.execution).toBeUndefined();
      return result;
    });
    const finalAcl = jest.spyOn(service as any, 'filterSearchResultsForUser').mockImplementation(async () => {
      expect(getRequestContext()?.execution).toBeUndefined();
      return []; // no verified candidates => no results
    });
    const fallback = jest.spyOn(service, 'searchChunksFallback').mockResolvedValue([]);
    let retrievalCalls = 0;
    const rerank = jest.spyOn(service as any, 'rerankByProbeGroups').mockImplementation(async () => {
      retrievalCalls = fallback.mock.calls.length;
      getRequestContext()!.execution!.deadline.abort();
    });
    try {
      const result = await service.searchKnowledgeForAgent('user-1', 'Which regulation applies?', ['kb-1'], 100);
      expect(poolAcl).toHaveBeenCalled();
      expect(finalAcl).toHaveBeenCalled();
      expect(result.results).toEqual([]);
      expect(result.execution).toBeDefined();
      // Probe work before rerank is allowed; no post-timeout augmentation.
      expect(fallback).toHaveBeenCalledTimes(retrievalCalls);
      finalAcl.mockRejectedValueOnce(new Error('ACL unavailable'));
      await expect(service.searchKnowledgeForAgent('user-1', 'Which regulation applies?', ['kb-1'], 100)).rejects.toThrow('ACL unavailable');
    } finally {
      poolAcl.mockRestore(); finalAcl.mockRestore(); fallback.mockRestore(); rerank.mockRestore();
      if (originalAdaptive === undefined) delete process.env.ADAPTIVE_RETRIEVAL_ENABLED;
      else process.env.ADAPTIVE_RETRIEVAL_ENABLED = originalAdaptive;
    }
  });

  it("defers WeKnora shadow comparisons to offline evaluation", async () => {
    const mockWeKnoraClient = {
      search: jest.fn().mockResolvedValue([
        {
          provider: "weknora",
          externalChunkId: "ext-1",
          documentId: "doc-1",
          kbId: "kb-1", aclMode: "inherit",
          documentVersion: 1,
          content: "外部WeKnora证据片段",
          score: 0.95,
        },
      ]),
    };

    const isolatedService = new ChatService(
      mockPermissionService as any,
      mockCompilerService as any,
      { resolveUserScope: jest.fn().mockResolvedValue({ scopedKbIds: ["kb-1"], fingerprint: "fp-1", aclEpoch: 1, knowledgeEpoch: 1 }) } as any,
      undefined,
      undefined,
      {
        initializeSource: jest.fn(),
        query: mockGbrainQuery,
        queryMany: mockGbrainQuery,
      } as any,
      mockWeKnoraClient as any,
    );

    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: "/tmp/repo" });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md", version: 1, qualityStatus: "passed", kb: { name: "知识库", type: "platform" } },
    ]);

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          cancel: jest.fn().mockResolvedValue(undefined),
          releaseLock: jest.fn(),
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"测试回答[1]"}}]}\n\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });
    (global as any).fetch = fetchMock;

    try {
      const stream$ = await isolatedService.handleChatStream("user-1", "测试问题", ["kb-1"]);
      const events = await lastValueFrom(stream$.pipe(toArray()));
      const weknoraEvents = events.filter((e) => (e.data as any).type === "trace" && (e.data as any).node.id === "weknora_retrieval");
      const weknoraTrace = weknoraEvents[weknoraEvents.length - 1];
      
      expect(weknoraTrace).toBeDefined();
      expect((weknoraTrace!.data as any).node.status).toBe("skipped");
      expect(mockWeKnoraClient.search).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("decomposeComplexQuery splits composite questions into focused sub-queries", () => {
    const q1 = "关于无人系统数据跨境出境与加密传输，本规范在第一章总则原则、第六章技术加密指标以及第十章特殊豁免附则中分别有哪些具体硬性要求？";
    const sub1 = service.decomposeComplexQuery(q1);
    expect(sub1.length).toBeGreaterThanOrEqual(2);
    expect(sub1.some((s) => s.includes("第一章"))).toBe(true);
    expect(sub1.some((s) => s.includes("第六章"))).toBe(true);

    const q2 = "若设备发生一级安全偏航事故且传感器存在历史未检修隐患记录，根据规范应如何定级、扣除多少安全积分，并执行怎样的责任人连带处分？";
    const sub2 = service.decomposeComplexQuery(q2);
    expect(sub2.length).toBeGreaterThanOrEqual(2);
    expect(sub2.some((s) => s.includes("一级安全偏航事故"))).toBe(true);

    const q3 = "请详细对比本规范中研发试验阶段与商业量产运营阶段在自主避障安全冗余裕度上的具体参数差异与设定原因。";
    const sub3 = service.decomposeComplexQuery(q3);
    expect(sub3.length).toBe(2);
    expect(sub3.some((s) => s.includes("研发试验阶段"))).toBe(true);
    expect(sub3.some((s) => s.includes("商业量产运营阶段"))).toBe(true);
  });

  it("resolveTemporalPrecedence detects multi-version documents and generates precedence warning", () => {
    const citations = [
      { docTitle: "安全管理规程 (V4.2.0)", version: 4, evidence: "新标准120米" },
      { docTitle: "安全管理规程 (V3.0.0)", version: 3, evidence: "旧标准50米" },
    ];
    const res = service.resolveTemporalPrecedence(citations);
    expect(res.hasVersionConflict).toBe(true);
    expect(res.temporalNotice).toContain("版本序号和上传时间不能证明旧版已废止");
    expect(res.temporalNotice).toContain("V4");
  });

  it('does not infer version precedence across knowledge bases', () => {
    const citations = [
      { kbId: 'kb-a', docTitle: 'Shared policy', version: 4 },
      { kbId: 'kb-b', docTitle: 'Shared policy', version: 1 },
    ];
    const res = service.resolveTemporalPrecedence(citations);
    expect(res.hasVersionConflict).toBe(false);
    expect(res.citations).toEqual(citations);
  });

  it('boosts rank of overlapping citations via WeKnora RRF fusion', () => {
    const baseCitations = [
      { docId: 'doc-A', topic: 'Doc A', evidence: 'base A', score: 0.9 },
      { docId: 'doc-B', topic: 'Doc B', evidence: 'base B', score: 0.8 },
    ];
    const weknoraEvidences = [
      { provider: 'weknora' as const, externalChunkId: 'c1', documentId: 'doc-B', kbId: 'kb1', documentVersion: 1, content: 'weknora B', score: 0.95 },
      { provider: 'weknora' as const, externalChunkId: 'c2', documentId: 'doc-C', kbId: 'kb1', documentVersion: 1, content: 'weknora C', score: 0.85 },
    ];
    const fused = (service as any).fuseWithWeKnoraRRF(baseCitations, weknoraEvidences, 60);
    // Fusion keeps passage-level granularity: the two engines returned different
    // passages of doc-B, so doc-B contributes two candidates instead of one
    // concatenated blob (doc-A, doc-B base, doc-B weknora, doc-C).
    expect(fused.length).toBe(4);
    // doc-B is surfaced by BOTH engines, so its entries are corroborated and its
    // strongest passage carries the fusion bonus and ranks first.
    expect(fused[0].docId).toBe('doc-B');
    expect(fused[0].dualVerified).toBe(true);
    expect(fused[0].providers).toContain('weknora');
    // A document corroborated by both engines marks every one of its passages.
    expect(fused.filter((f: any) => f.docId === 'doc-B').every((f: any) => f.dualVerified)).toBe(true);
    // doc-C was discovered only by WeKnora, should be present
    expect(fused.some((f: any) => f.docId === 'doc-C')).toBe(true);
  });

  it('augmentWithRaptorGlobalTree prepends Level 2 global evolution nodes on macro questions', async () => {
    const mockRaptor = {
      isEnabled: () => true,
      searchGlobal: jest.fn().mockResolvedValue([
        {
          documentId: null,
          kbId: 'kb-1', aclMode: 'inherit',
          title: '全库业务架构与制度演进全景',
          evidence: '【宏观摘要 · 全库演进全景】涵盖人事与合规整体演进架构',
          score: 0.96,
          level: 2,
          raptor: true,
          section: 'raptor-level2-global',
        },
      ]),
    };
    (service as any).retrievalArms.raptorService = mockRaptor;

    const mockTrace = { start: jest.fn(), finish: jest.fn(), skip: jest.fn() };
    const queryResult = {
      citations: [
        { docId: 'doc-1', evidence: '普通章节内容', score: 0.8 },
      ],
    };

    const augmented = await (service as any).augmentWithRaptorGlobalTree(
      queryResult,
      ['kb-1'],
      '请总结全库的业务架构与长期演进历程有哪些',
      'global_synthesis',
      mockTrace,
    );

    expect(mockRaptor.searchGlobal).toHaveBeenCalledWith(['kb-1'], expect.any(String), 4);
    expect(augmented.citations.length).toBe(2);
    expect(augmented.citations[0].level).toBe(2);
    expect(augmented.citations[0].evidence).toContain('全库演进全景');
    expect(mockTrace.finish).toHaveBeenCalledWith('raptor_macro_retrieval', 'success', expect.any(String), expect.any(Object));
  });

  it('retrieveHopProbes retrieves and tags candidates for subsequent hops', async () => {
    jest.spyOn((service as any).retrievalArms, 'searchChunksFallback').mockResolvedValue([
      {
        documentId: 'doc-hop',
        kbId: 'kb-1', aclMode: 'inherit',
        title: '量产公差规范',
        evidence: '量产公差不得大于0.02mm',
        previewUrl: null,
      },
    ]);

    const hits = await (service as any).retrieveHopProbes(
      ['kb-1'],
      ['gbrain://source/1'],
      '/tmp/repo',
      ['量产公差规范'],
      undefined,
      undefined,
      undefined,
      2,
    );

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docId).toBe('doc-hop');
    expect(hits[0].hop).toBe(2);
    expect(hits[0].subQueryOrigin).toBe('量产公差规范');
  });

  it('searchChunksFallback scopes domainTerms to query and prioritizes targeted document title', async () => {
    (service as any).retrievalArms.scopeDomainTermsCache.set('kb-target', {
      terms: ['绩效考核', '指标体系', '总则', '处分', '安全偏航'],
      expiresAt: Date.now() + 60000,
    });

    const mockPrisma = {
      chunk: {
        findMany: jest.fn().mockImplementation((args) => {
          if (args.where?.OR && args.where.OR.some((x: any) => x.content?.contains === '第十条')) {
            return Promise.resolve([
              {
                id: 'chunk-target',
                documentId: 'doc-target',
                kbId: 'kb-target',
                ord: 3,
                content: '## 第三章 使用管理\n\n**第十条** 建立公务用车管理台账，对车辆使用时间进行登记。',
                metadata: {},
                document: { title: '公车管理办法.docx', version: 1 },
              },
              {
                id: 'chunk-irrelevant',
                documentId: 'doc-irrelevant',
                kbId: 'kb-target',
                ord: 12,
                content: '## 绩效考核总则与处分指标体系\n\n**第十条** 绩效考核办法与指标体系。',
                metadata: {},
                document: { title: '绩效考核方案.docx', version: 1 },
              },
            ]);
          }
          if (args.where?.documentId?.in) {
            return Promise.resolve([
              {
                id: 'chunk-target',
                documentId: 'doc-target',
                kbId: 'kb-target',
                ord: 3,
                content: '## 第三章 使用管理\n\n**第十条** 建立公务用车管理台账，对车辆使用时间进行登记。',
                metadata: {},
                document: { title: '公车管理办法.docx', version: 1 },
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      },
      document: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'doc-target', title: '公车管理办法.docx' },
        ]),
      },
    };
    Object.assign(mockPrisma, { $transaction: async (fn: any) => fn(mockPrisma), $queryRaw: jest.fn().mockResolvedValue([]) });
    (service as any).retrievalArms.prisma = mockPrisma;
    (service as any).retrievalArms.searchChunksByVector = jest.fn().mockResolvedValue([]);

    const results = await (service as any).retrievalArms.searchChunksFallback(['kb-target'], '公车管理办法第十条内容是什么。', 15);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].documentId).toBe('doc-target');
    expect(results[0].title).toBe('公车管理办法.docx');
    expect(results[0].evidence).toContain('建立公务用车管理台账');
  });

  describe("hasPolarityConflict", () => {
    it("detects threshold directional contradictions", () => {
      expect(hasPolarityConflict("响应时间不得高于 800 毫秒", "响应时间不得低于 800 毫秒")).toBe(true);
      expect(hasPolarityConflict("响应时间可以高于 800 毫秒", "响应时间不得超过 800 毫秒")).toBe(true);
      expect(hasPolarityConflict("响应时间小于 100 毫秒", "响应时间不得低于 100 毫秒")).toBe(true);
      expect(hasPolarityConflict("响应时间低于 800 毫秒", "响应时间不得高于 800 毫秒")).toBe(false);
    });

    it("detects permission vs prohibition conflicts", () => {
      expect(hasPolarityConflict("员工可以私自转借车辆", "员工严禁私自转借车辆")).toBe(true);
      expect(hasPolarityConflict("员工不得私自转借车辆", "员工严禁私自转借车辆")).toBe(false);
      expect(hasPolarityConflict("员工应当如实登记车辆里程", "员工不得如实登记车辆里程")).toBe(true);
    });

    it("detects English directional and prohibition contradictions", () => {
      expect(hasPolarityConflict("The latency must not exceed 800ms", "The latency must be at least 800ms")).toBe(true);
      expect(hasPolarityConflict("Users are permitted to export raw logs", "Users are strictly forbidden from exporting raw logs")).toBe(true);
      expect(hasPolarityConflict("Users shall not export raw logs", "Users are strictly forbidden from exporting raw logs")).toBe(false);
    });

    it("does not flag compatible lower/upper bounds, but flags inverted ones", () => {
      expect(hasPolarityConflict("报价下限为 5 万元", "报价上限为 10 万元")).toBe(false);
      expect(hasPolarityConflict("报价下限为 15 万元", "报价上限为 10 万元")).toBe(true);
    });

    it("detects expanded permission lexicons", () => {
      expect(hasPolarityConflict("该环节为可选", "该环节禁止跳过")).toBe(true);
    });
  });

  describe("statementSupportedBy", () => {
    it("validates grounded statements with citations", () => {
      const evidence = ["《公车管理办法》第三章：建立公务用车管理台账，对车辆使用时间进行登记。每次使用必须如实填写里程。"];
      expect(statementSupportedBy("建立公务用车管理台账并对车辆使用时间进行登记 [1]", evidence, true)).toBe(true);
    });

    it("rejects statements with polarity conflicts even if keywords match", () => {
      const evidence = ["《网络安全管理规定》第五条：严禁未经审批私自开放外网端口。"];
      expect(statementSupportedBy("员工可以私自开放外网端口 [1]", evidence, true)).toBe(false);
    });

    it("rejects statements with hallucinated numbers", () => {
      const evidence = ["系统响应时间不得超过 800 毫秒。"];
      expect(statementSupportedBy("系统响应时间不得超过 500 毫秒 [1]", evidence, true)).toBe(false);
    });

    it("accepts a correct unit conversion as grounded", () => {
      const evidence = ["系统响应时间不得超过 0.8s。"];
      expect(statementSupportedBy("系统响应时间不得超过 800 毫秒 [1]", evidence, true)).toBe(true);
    });
  });

  describe("Brain Scope Derived Intelligence", () => {
    it("injects scope derived intelligence for macro questions", async () => {
      mockPrisma.brainDerivedPage.findMany.mockResolvedValueOnce([
        {
          id: "derived-1",
          slug: "derived/scope-summary",
          title: "Scope 知识资产综合全景",
          content: "这是当前权限 Scope 下的综合知识资产概览与制度全景。",
          aclEpoch: 2,
        },
      ]);

      const result = await (service as any).augmentWithBrainDerivedIntelligence(
        { citations: [] },
        { scopeId: "scope-1", aclEpoch: 2 },
        "请概述全部制度资产与全景目录",
        "global_synthesis",
      );

      expect(result.citations).toHaveLength(1);
      expect(result.citations[0].isCompiledDerived).toBe(true);
      expect(result.citations[0].docTitle).toBe("Scope 知识资产综合全景");
      expect(result.citations[0].aclEpoch).toBe(2);
    });

    it("skips scope derived intelligence when citations exist for simple questions", async () => {
      const existingCitations = [{ docId: "doc-1", snippet: "具体内容" }];
      const result = await (service as any).augmentWithBrainDerivedIntelligence(
        { citations: existingCitations },
        { scopeId: "scope-1", aclEpoch: 2 },
        "差旅费标准是多少",
        "simple",
      );

      expect(result.citations).toEqual(existingCitations);
      expect(mockPrisma.brainDerivedPage.findMany).not.toHaveBeenCalled();
    });
  });

  describe("General Stride-1 N-gram Tokenizer", () => {
    it("extracts all continuous n-grams (4, 3, 2) without skipping odd-offset characters", () => {
      const kws = (service as any).extractSearchKeywords("员工夏天上下班的时间要求是什么。");
      expect(kws).toContain("上下班");
      expect(kws).toContain("下班");
      expect(kws).toContain("员工");
      expect(kws).toContain("夏天");
      expect(kws).toContain("时间");
      expect(kws).toContain("要求");
    });

    it("extracts odd-offset compounds from specific queries", () => {
      const kws = (service as any).extractSearchKeywords("具体上下班时间。");
      expect(kws).toContain("上下班");
      expect(kws).toContain("下班");
      expect(kws).toContain("时间");
      expect(kws).toContain("具体");
    });
  });

  describe("smartTruncateChunkText", () => {
    it("returns full text when text length is within maxChunkLen", () => {
      const text = "短文本无需截断";
      expect(smartTruncateChunkText(text, 100)).toBe(text);
    });

    it("truncates at paragraph boundary when available in safe zone", () => {
      const p1 = "第一段文本详细说明。".repeat(10);
      const p2 = "第二段文本继续说明。".repeat(10);
      const combined = `${p1}\n\n${p2}`;
      const truncated = smartTruncateChunkText(combined, p1.length + 20);
      expect(truncated).toContain(p1);
      expect(truncated).not.toContain(p2);
      expect(truncated).toContain("...[内容超出篇幅限制截断]");
    });

    it("truncates at table row boundary without slicing markdown table rows in half", () => {
      const header = "| 序号 | 队伍 | 分数 |\n| :--- | :--- | :--- |";
      const rows = Array.from({ length: 20 }, (_, i) => `| ${i + 1} | 队伍${i + 1}名称 | ${80 + i} |`).join("\n");
      const fullTable = `${header}\n${rows}`;
      // Truncate at halfway point
      const limit = Math.floor(fullTable.length * 0.6);
      const truncated = smartTruncateChunkText(fullTable, limit);
      // It should end with the table truncation marker and not have broken half-lines
      expect(truncated).toContain("| ... (表格后续行因篇幅限制截断) |");
      // Must not end with a partial row without closing pipe
      const lines = truncated.split("\n").filter((l) => l.startsWith("|"));
      for (const line of lines) {
        expect(line.endsWith("|")).toBe(true);
      }
    });
  });

  describe("stitchContiguousCitations", () => {
    it("returns empty array or single citation unmodified", () => {
      expect(service.stitchContiguousCitations([])).toEqual([]);
      const single = [{ docId: "d1", docTitle: "Doc 1", ord: 0, context: "Text 1" }];
      expect(service.stitchContiguousCitations(single)).toEqual(single);
    });

    it("stitches physically contiguous chunks of the same document and merges page range", () => {
      const citations = [
        { docId: "d1", docTitle: "Doc 1", ord: 0, pageNo: 1, score: 0.85, context: "第一部分内容介绍。" },
        { docId: "d1", docTitle: "Doc 1", ord: 1, pageNo: 2, score: 0.90, context: "第二部分内容深入讲解。" },
      ];
      const result = service.stitchContiguousCitations(citations);
      expect(result).toHaveLength(1);
      expect(result[0].docId).toBe("d1");
      expect(result[0].pageNo).toBe("1-2");
      expect(result[0].score).toBe(0.90);
      expect(result[0].context).toBe("第一部分内容介绍。\n\n第二部分内容深入讲解。");
    });

    it("preserves sub-question and bridge provenance across stitched chunks", () => {
      const citations = [
        {
          docId: "d1", ord: 0, score: 0.9, context: "第一跳。",
          subQueryOrigin: "first hop",
        },
        {
          docId: "d1", ord: 1, score: 0.8, context: "第二跳。",
          subQueryOrigin: "second hop", bridgeRescue: true, hop: 2,
        },
      ];
      const result = service.stitchContiguousCitations(citations);
      expect(result).toHaveLength(1);
      expect(result[0].subQueryOrigins).toEqual(["first hop", "second hop"]);
      expect(result[0].bridgeRescue).toBe(true);
      expect(result[0].hop).toBe(2);
    });

    it("seamlessly resolves mid-sentence cutoff across chunk boundary when no punctuation ends the first chunk", () => {
      const citations = [
        { docId: "d1", docTitle: "Doc 1", ord: 0, pageNo: 1, context: "13. 强化融资服务保障：鼓励各地联合创" },
        { docId: "d1", docTitle: "Doc 1", ord: 1, pageNo: 2, context: "新金融支持模式。14. 优化合规服务保障。" },
      ];
      const result = service.stitchContiguousCitations(citations);
      expect(result).toHaveLength(1);
      expect(result[0].context).toBe("13. 强化融资服务保障：鼓励各地联合创新金融支持模式。14. 优化合规服务保障。");
      expect(result[0].context).toContain("联合创新金融支持模式");
    });

    it("removes overlapping sentence boundary across chunks", () => {
      const overlapText = "这是跨切片完全一致的重叠过渡语句。";
      const citations = [
        { docId: "d1", docTitle: "Doc 1", ord: 0, pageNo: 1, context: `前文阐述详细机制。${overlapText}` },
        { docId: "d1", docTitle: "Doc 1", ord: 1, pageNo: 2, context: `${overlapText}后文继续论述具体落地措施。` },
      ];
      const result = service.stitchContiguousCitations(citations);
      expect(result).toHaveLength(1);
      expect(result[0].context).toBe(`前文阐述详细机制。${overlapText}后文继续论述具体落地措施。`);
      // Should not have duplicated the overlap
      const occurrences = (result[0].context.match(new RegExp(overlapText, "g")) || []).length;
      expect(occurrences).toBe(1);
    });

    it("strips duplicate heading or hierarchy tags from subsequent chunks", () => {
      const citations = [
        { docId: "d1", docTitle: "Doc 1", ord: 0, pageNo: 1, context: "前置大纲正文。" },
        { docId: "d1", docTitle: "Doc 1", ord: 1, pageNo: 2, context: "<!-- 大纲层级: 一、概述 > 重点工作 -->\n# Doc 1\n接续正文内容。" },
      ];
      const result = service.stitchContiguousCitations(citations);
      expect(result).toHaveLength(1);
      expect(result[0].context).toBe("前置大纲正文。\n\n接续正文内容。");
      expect(result[0].context).not.toContain("大纲层级");
      expect(result[0].context).not.toContain("# Doc 1");
    });

    it("does not stitch non-contiguous chunks or chunks from different documents", () => {
      const citations = [
        { docId: "d1", docTitle: "Doc 1", ord: 0, pageNo: 1, score: 0.9, context: "文档1切片0" },
        { docId: "d1", docTitle: "Doc 1", ord: 5, pageNo: 6, score: 0.8, context: "文档1切片5（跳跃）" },
        { docId: "d2", docTitle: "Doc 2", ord: 1, pageNo: 1, score: 0.7, context: "文档2切片1" },
      ];
      const result = service.stitchContiguousCitations(citations);
      expect(result).toHaveLength(3);
    });

    it("triggers fast standard refusal when no citations or sufficient evidence is found", async () => {
      mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
      mockCompilerService.ensureUserBrainRepo.mockResolvedValue({ gitRepoUrl: "/tmp/repo" });
      mockGbrainQuery.mockResolvedValue({
        topics: [],
        answer: "",
        citations: [],
        reranked: true,
      });
      jest.spyOn(service as any, "searchChunksFallback").mockResolvedValue([]);

      const stream$ = await service.handleChatStream("user-1", "不存在的技术标准是什么？", ["kb-1"]);
      const events = await lastValueFrom(stream$.pipe(toArray()));
      const deltas = events.filter((e) => (e.data as any).type === "delta");
      expect(deltas.length).toBeGreaterThan(0);
      expect((deltas[0].data as any).content).toContain("已知知识库资料中未包含与该问题直接相关的信息");
    });

    it("emits ZERO citations when every sentence is held and the answer degrades to the standard refusal", async () => {
      // Regression (2026-10-10): the synthesized refusal used to ship the ranked
      // retrieval candidates as citations — the UI showed "引用 20 条" beside an
      // answer that explicitly says nothing was found. A marker-less refusal
      // references no source, and the done event must mark answer_kind=refusal so
      // the controller persists a non_evidence dependency manifest.
      process.env.RETRIEVAL_SIBLING_EDITION_ALIGN = "false";
      mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
      mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
        id: "repo-1",
        gitRepoUrl: "/tmp/repo",
      });
      // Self-contained retrieval mock: one ranked citation must come back so the
      // run reaches generation (the shared default is mutated by earlier tests).
      mockGbrainQuery.mockResolvedValue({
        topics: ["数据合规"],
        answer: "Compiled truth",
        citations: [
          {
            topic: "数据合规",
            docId: "doc-1",
            docTitle: "规则.md",
            snippet: "Compiled truth",
            score: 0.9,
          },
        ],
        reranked: true,
      });

      mockPrisma.document.findMany.mockReset().mockImplementation(async (args: any) => {
        if (args.where?.supersedesDocumentId) return [];
        return [
          { id: "doc-1", kbId: "kb-1", aclMode: "inherit", title: "规则.md", version: 1,
            kb: { name: "知识库", type: "platform" } },
        ];
      });

      process.env.DEEPSEEK_API_KEY = "test-key";
      const originalFetch = global.fetch;
      // The streamed sentence ("这里是回答") does not overlap the citation
      // evidence ("Compiled truth"), so the grounding gate holds it and the
      // pipeline falls back to the standard refusal.
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            cancel: jest.fn().mockResolvedValue(undefined),
            releaseLock: jest.fn(),
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"这里是回答[1]"}}]}\n\n') })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      });
      (global as any).fetch = fetchMock;

      try {
        const stream$ = await service.handleChatStream("user-1", "测试问题", ["kb-1"]);
        const events = await lastValueFrom(stream$.pipe(toArray()));

        const citationEvents = events.filter((e) => (e.data as any).type === "citation");
        expect(citationEvents).toHaveLength(0);

        const answerText = events
          .filter((e) => ["delta", "replace"].includes((e.data as any)?.type))
          .map((e) => String((e.data as any).content || ""))
          .join("");
        expect(answerText).toContain("已知知识库资料中未包含相关信息，无法回答该问题。");

        const done = events.find((e) => (e.data as any).type === "done");
        expect((done?.data as any)?.answer_kind).toBe("refusal");
      } finally {
        (global as any).fetch = originalFetch;
        delete process.env.DEEPSEEK_API_KEY;
      }
    });
  });

  describe("truncateChunkToTokenBudget", () => {
    it("fits CJK evidence inside the requested token allowance", () => {
      const bounded = truncateChunkToTokenBudget("制度条款".repeat(500), 120, 2000);
      expect(estimateTokens(bounded)).toBeLessThanOrEqual(120);
      expect(bounded).toContain("截断");
    });

    it("does not alter evidence that already fits", () => {
      expect(truncateChunkToTokenBudget("short evidence", 100)).toBe("short evidence");
    });
  });
});

describe("isStrongNameEntity", () => {
  // The bridge probe for a *mention-only* entity (no document titled after it) is
  // gated on this shape check, so it has to accept real multi-token names and
  // reject the prose fragments that earlier, looser probes tripped over.
  it("accepts multi-token capitalised names", () => {
    for (const name of [
      "David Gest",
      "Washington Island",
      "Door County Wisconsin",
      "Ebba Brahe",
      "Andrei Ujică",
      "Jean-Luc Godard",
    ]) {
      expect(isStrongNameEntity(name)).toBe(true);
    }
  });

  it("rejects single words, prose fragments and over-long spans", () => {
    for (const value of [
      "",
      "Jackson",
      "Life",
      "O'Brien",
      "the film was released",
      "Gone with the Wind is a 1939",
      "one two three four five",
      "  ",
    ]) {
      expect(isStrongNameEntity(value)).toBe(false);
    }
  });
});

describe('isStructuralHeadingLine', () => {
  /**
   * Plain-text headings (no bold, no '#') were classified as claims, held by the
   * grounding gate for lacking evidence, and recovered at the END of the answer.
   * That is the reported "标题跑到最后/错位" symptom: a section heading is
   * navigation, not a claim, so it must never be gated on evidence.
   */
  it('recognises plain-text section headings the model emits without markup', () => {
    expect(isStructuralHeadingLine('一、迟到一小时的处理')).toBe(true);
    expect(isStructuralHeadingLine('二、处理方式')).toBe(true);
    expect(isStructuralHeadingLine('三、常见问题与解答')).toBe(true);
    expect(isStructuralHeadingLine('2. 处理方式')).toBe(true);
    expect(isStructuralHeadingLine('一、总则')).toBe(true);
    expect(isStructuralHeadingLine('四、责任认定与申诉渠道')).toBe(true);
  });

  it('does not mistake an ordinal-led rule statement for a heading', () => {
    // Limit wording, a predicate applied to someone, or a quantity makes the
    // line a claim, which must still face the evidence gate. The examples are
    // structural only (no domain vocabulary), matching the classifier.
    expect(isStructuralHeadingLine('二、超过一小时以上的处理')).toBe(false);
    expect(isStructuralHeadingLine('一、超过一小时以内')).toBe(false);
    expect(isStructuralHeadingLine('一、应当提交书面申请')).toBe(false);
    expect(isStructuralHeadingLine('1. 每月累计三次以上不予通过')).toBe(false);
    expect(isStructuralHeadingLine('二、超过30分钟视为异常')).toBe(false);
    expect(isStructuralHeadingLine('（一）超过一小时以内按10处理')).toBe(false);
  });

  it('recognises the production heading shapes that were held and re-appended', () => {
    expect(isStructuralHeadingLine('**一、技能生态的三类技能来源**')).toBe(true);
    expect(isStructuralHeadingLine('**三、技能接入与创建**\n')).toBe(true);
    expect(isStructuralHeadingLine('## 二、页面整体功能')).toBe(true);
    expect(isStructuralHeadingLine('**五、政务产业落地的生态化路径（多源印证）**')).toBe(true);
    expect(isStructuralHeadingLine('（一）总体要求')).toBe(true);
  });

  it('does not fast-path factual content lines', () => {
    // labeled claim: 标签+冒号+事实 → 交回证据门禁
    expect(isStructuralHeadingLine('**1. 预置高频通用技能**：桌面版预置Word、Excel、PDF等办公场景的高频技能 [1]')).toBe(false);
    expect(isStructuralHeadingLine('- 虚拟机和沙盒：隔离、权限控制与备份（支持快速回滚）[2]')).toBe(false);
    // 完整陈述句
    expect(isStructuralHeadingLine('技能可根据任务需求自动匹配调用。')).toBe(false);
    // 长行
    expect(isStructuralHeadingLine('**一、技能生态的三类技能来源、四类接入路径与五步实施方**'.repeat(2))).toBe(false);
  });
});

describe('isStructuralHeadingLine / isTableSyntaxLine (production follow-up shapes)', () => {

  it('recognises headings that carry citation markers', () => {
    expect(isStructuralHeadingLine('**一、现行版 V2.0 的上下班要求[2]**')).toBe(true);
    expect(isStructuralHeadingLine('**二、旧版《企业考勤管理制度详细手册》的规定[1]**')).toBe(true);
  });

  it('recognises short colon lead-ins but not digit-bearing labeled claims', () => {
    expect(isStructuralHeadingLine('两版规定存在差异，分别陈述如下:')).toBe(true);
    expect(isStructuralHeadingLine('打卡时间为08:30:')).toBe(false);
    expect(isStructuralHeadingLine('**打卡要求**：员工上下班均需打卡，作为考勤记录的唯一依据')).toBe(false);
  });

  it('classifies table lines as table syntax, not headings', () => {
    expect(isTableSyntaxLine('| 事项 | 旧版（详细手册） | 现行版 V2.0 |')).toBe(true);
    expect(isTableSyntaxLine('|---|---|---|')).toBe(true);
    expect(isTableSyntaxLine('| 上班时间 | 08:30 起（分夏/冬令时）[1] | 09:00[2] |')).toBe(true);
    expect(isTableSyntaxLine('普通句子')).toBe(false);
    expect(isStructuralHeadingLine('| 事项 | 旧版 | 现行版 |')).toBe(false);
  });
});


describe('isBlockLevelStart (layout normalisation)', () => {
  it('flags headings, table lines and list items', () => {
    expect(isBlockLevelStart('**二、旧版《企业考勤管理制度详细手册》的规定[1]**')).toBe(true);
    expect(isBlockLevelStart('| 事项 | 旧版 | 现行版 |')).toBe(true);
    expect(isBlockLevelStart('|---|---|')).toBe(true);
    expect(isBlockLevelStart('1. **工作时间**：周一至周五，每天8小时[2]。')).toBe(true);
    expect(isBlockLevelStart('- 预置Word、Excel、PDF等办公场景的高频技能 [2]')).toBe(true);
    expect(isBlockLevelStart('3. **混合办公模式（"3+2"）**：每周至少到办公室工作3天[2]。')).toBe(true);
  });

  it('does not break ordinary prose sentences', () => {
    expect(isBlockLevelStart('现行有效版本为《企业考勤制度手册V2》（版本号 V2.0）[2]。')).toBe(false);
    expect(isBlockLevelStart('标准工时制适用于行政、后勤岗位。')).toBe(false);
    // 句中数字非列表起始
    expect(isBlockLevelStart('每周工作5天、每天8小时[2]。')).toBe(false);
  });
});

describe('isStructuralHeadingLine (ordinal heading with nominal colon payload)', () => {
  it('recognises the three production shapes missed before', () => {
    expect(isStructuralHeadingLine('**一、现行有效版本：V2《企业考勤制度手册V2.docx》（现行有效）**')).toBe(true);
    expect(isStructuralHeadingLine('**二、另一份制度：《企业考勤管理制度详细手册.doc》（库中对应 v1 版本，非现行有效版）**')).toBe(true);
    expect(isStructuralHeadingLine('**三、生态开放：第三方产品接入路径**')).toBe(true);
  });

  it('still gates ordinal labels whose payload is a factual claim', () => {
    // 载荷带角标 → 事实句
    expect(isStructuralHeadingLine('**1. 预置高频通用技能**：桌面版预置Word、Excel、PDF等办公场景的高频技能 [1]')).toBe(false);
    // 载荷以句号收尾 → 完整陈述
    expect(isStructuralHeadingLine('**二、打卡要求**：员工上下班均需打卡。')).toBe(false);
    // 冒号后为空的列表标签:引导其嵌套子项,须保位(非声明)
    expect(isStructuralHeadingLine('- **作息安排分令时执行**：')).toBe(true);
    // 冒号后是取值区间 → 声明,交回门禁
    expect(isStructuralHeadingLine('**一、上班时间**：09:00-18:00')).toBe(false);
  });
});

describe('deterministicChunkCap', () => {
  it('defaults to a cap large enough for real regulation manuals', () => {
    expect(deterministicChunkCap({} as NodeJS.ProcessEnv)).toBe(20_000);
  });

  it('is configurable via CHAT_DETERMINISTIC_MAX_CHUNKS', () => {
    expect(
      deterministicChunkCap({ CHAT_DETERMINISTIC_MAX_CHUNKS: '50000' } as NodeJS.ProcessEnv),
    ).toBe(50_000);
  });

  it('falls back to the default on invalid or non-positive values', () => {
    expect(deterministicChunkCap({ CHAT_DETERMINISTIC_MAX_CHUNKS: '0.5' })).toBe(20_000);
    expect(
      deterministicChunkCap({ CHAT_DETERMINISTIC_MAX_CHUNKS: 'abc' } as NodeJS.ProcessEnv),
    ).toBe(20_000);
    expect(
      deterministicChunkCap({ CHAT_DETERMINISTIC_MAX_CHUNKS: '0' } as NodeJS.ProcessEnv),
    ).toBe(20_000);
    expect(
      deterministicChunkCap({ CHAT_DETERMINISTIC_MAX_CHUNKS: '-5' } as NodeJS.ProcessEnv),
    ).toBe(20_000);
  });

  it('clamps an absurdly high configuration to a hard ceiling', () => {
    expect(
      deterministicChunkCap({ CHAT_DETERMINISTIC_MAX_CHUNKS: '99999999' } as NodeJS.ProcessEnv),
    ).toBe(200_000);
  });
});
