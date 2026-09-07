import { Test, TestingModule } from "@nestjs/testing";
import { ChatService } from "./chat.service";
import { PermissionService } from "../permission/permission.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { BrainScopeService } from "../brain-compiler/brain-scope.service";
import { lastValueFrom, toArray } from "rxjs";
import { GraphRagService } from "../graph-rag/graph-rag.service";

const mockGraphRag = {
  searchLocalGraph: jest.fn().mockResolvedValue({
    entities: [{ name: "withdrawn-document" }], relations: [],
    formattedContext: "UNVERIFIED_WITHDRAWN_GRAPH_SECRET",
  }),
  searchGlobalCommunities: jest.fn().mockResolvedValue({
    communities: [], formattedContext: "UNVERIFIED_WITHDRAWN_GRAPH_SECRET",
  }),
};

// Mocks
const mockPermissionService = {
  getVisibleKnowledgeBases: jest.fn(),
};

const mockCompilerService = {
  triggerLazyCompileAndWait: jest.fn(),
  ensureUserBrainRepo: jest.fn(),
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
    },
  ],
  reranked: true,
});

const mockPrisma = {
  brainRepo: {
    findUnique: jest.fn(),
  },
  brainTopic: {
    findUnique: jest.fn(),
  },
  document: {
    findMany: jest.fn(),
  },
  message: {
    findMany: jest.fn(),
  },
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));

jest.mock("@llmwiki/gbrain-adapter", () => ({
  BrainRepoAdapter: jest.fn().mockImplementation(() => ({
    query: mockGbrainQuery,
    isSourceMaterialized: jest.fn().mockResolvedValue(false),
  })),
}));

describe("ChatService", () => {
  let service: ChatService;

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
    expect(captured?.aborted).toBe(false);
    subscription.unsubscribe();
    expect(captured?.aborted).toBe(true);
  });

  beforeEach(async () => {
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
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    jest.clearAllMocks();
  });

  it("should stream chat and trigger lazy compile if topic is dirty", async () => {
    // 权限校验 mock
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);

    // Brain repo mock
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", title: "规则.md" },
    ]);

    // 模拟主题是 dirty 的，触发懒编译
    mockPrisma.brainTopic.findUnique.mockResolvedValue({
      compileStatus: "dirty",
    });
    mockCompilerService.triggerLazyCompileAndWait.mockResolvedValue(undefined);

    const stream$ = await service.handleChatStream("user-1", "测试问题");
    const events = await lastValueFrom(stream$.pipe(toArray()));

    // 验证懒编译被调用
    expect(mockCompilerService.triggerLazyCompileAndWait).toHaveBeenCalledWith(
      "user-1",
      "数据合规",
    );

    // 验证流式事件输出
    expect(events.some((e) => (e.data as any).type === "meta")).toBeTruthy();
    expect(events.some((e) => (e.data as any).type === "delta")).toBeTruthy();
    expect(
      events.some((e) => (e.data as any).type === "citation"),
    ).toBeTruthy();
    expect(events.some((e) => (e.data as any).type === "done")).toBeTruthy();
  });

  it("should preserve conversation context without sending stale assistant turns as live messages", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });
    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", title: "规则.md" },
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
      expect(requestBody.messages.slice(1)).toEqual([
        { role: "user", content: "当前问题" },
      ]);
      expect(requestBody.messages[0].content).toContain("上一轮问题");
      expect(requestBody.messages[0].content).toContain("上一轮回答");
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
      { id: "doc-1", kbId: "kb-1", title: "规则.md" },
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

  it("should remove low-score distractors from focused retrieval", () => {
    const result = (service as any).applyFocusedEvidenceGate({
      citations: [
        { topic: "目标制度", score: 0.33, context: "目标内容" },
        { topic: "无关制度", score: 0.08, context: "无关内容" },
      ],
      topics: ["目标制度", "无关制度"],
      answer: "目标内容\n\n无关内容",
      reranked: true,
    }, false);

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].topic).toBe("目标制度");
    expect(result.retrievalGate.removed).toBe(1);
  });

  it("should retain the wider candidate set for breadth retrieval", () => {
    const input = {
      citations: [
        { topic: "制度一", score: 0.33 },
        { topic: "制度二", score: 0.08 },
      ],
    };
    expect((service as any).applyFocusedEvidenceGate(input, true)).toBe(input);
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
    // 1. Initial layer permission check (retrieval time)
    mockPermissionService.getVisibleKnowledgeBases
      .mockResolvedValueOnce(["kb-1"]) // First call in processChat
      .mockResolvedValueOnce(["kb-1"]); // Second call in emitCitationsAndComplete

    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });

    // 2. Initial layer doc check passes
    mockPrisma.document.findMany
      .mockResolvedValueOnce([
        { id: "doc-1", kbId: "kb-1", title: "规则.md", kb: { name: "知识库", type: "platform" } },
      ])
      // middle version check
      .mockResolvedValueOnce([
        { id: "doc-1", title: "规则.md" },
      ])
      // 3. Third-layer emission doc check FAILS (returns empty array, meaning doc-1 was revoked or unpublished)
      .mockResolvedValueOnce([]);

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"query":"测试问题","breadth":false}' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            // Streaming an answer that cites [1]
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
      
      // Ensure we hit the database three times (once at retrieval, once at version conflict check, once at emission)
      expect(mockPrisma.document.findMany).toHaveBeenCalledTimes(3);

      // Verify citation event was stripped (not emitted)
      const citationEvents = events.filter((e) => (e.data as any).type === "citation");
      expect(citationEvents.length).toBe(0); // Should be empty because doc-1 was stripped

    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
  it("should detect version conflicts and include version details in timeline_entry", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);

    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });

    mockPrisma.document.findMany
      .mockResolvedValueOnce([
        { id: "doc-1", kbId: "kb-1", title: "规则.md", version: 2, kb: { name: "知识库", type: "platform" } },
      ])
      .mockResolvedValueOnce([
        { id: "doc-1", title: "规则.md", version: 2 },
        { id: "doc-2", title: "规则.md", version: 3 },
      ])
      .mockResolvedValueOnce([
        { id: "doc-1" },
      ]);

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
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
      expect(citationEvents.length).toBe(1);
      
      const timelineEntry = (citationEvents[0].data as any).timeline_entry;
      expect(timelineEntry.version).toBe(2);
      expect(timelineEntry.version_conflict).toEqual({
        hasConflict: true,
        currentVersion: 2,
        allVersions: [3, 2],
      });
      expect(timelineEntry.preview_url).toBe("/api/v1/kbs/kb-1/documents/doc-1/preview");
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
      mockPrisma.document.findMany.mockReset(); // reset for next tests
    }
  });
  it("should verify semantic evidence coverage and flag low coverage with a warning", async () => {
    mockPermissionService.getVisibleKnowledgeBases.mockResolvedValue(["kb-1"]);
    mockCompilerService.ensureUserBrainRepo.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });

    mockPrisma.document.findMany.mockResolvedValue([
      { id: "doc-1", kbId: "kb-1", title: "规则.md", version: 1, kb: { name: "知识库", type: "platform" } },
    ]);

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
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
      
      const traceEvents = events.filter((e) => (e.data as any).type === "trace" && (e.data as any).node.id === "citation_validation");
      const finalTrace = traceEvents[traceEvents.length - 1];
      
      expect(finalTrace).toBeDefined();
      expect((finalTrace.data as any).node.status).toBe("warning");
      expect((finalTrace.data as any).node.summary).toContain("证据语义覆盖率偏低");
      expect((finalTrace.data as any).node.details.semanticCoverage).toBeDefined();
      expect((finalTrace.data as any).node.details.semanticCoverage.coverageRatio).toBeLessThan(0.5);
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
      { id: "doc-1", kbId: "kb-1", title: "规则.md", version: 1, qualityStatus: "passed" },
    ]);

    const result = await service.searchKnowledgeForAgent("user-1", "数据合规", ["kb-1"], 5);
    expect(result.success).toBe(true);
    expect(result.query).toBe("数据合规");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].documentId).toBe("doc-1");
    expect(result.results[0].previewUrl).toContain("/api/v1/ingestion/documents/doc-1/preview");
  });

  it("weknora_retrieval runs in shadow mode when WeKnora client is provided", async () => {
    const mockWeKnoraClient = {
      search: jest.fn().mockResolvedValue([
        {
          provider: "weknora",
          externalChunkId: "ext-1",
          documentId: "doc-1",
          kbId: "kb-1",
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
      { id: "doc-1", kbId: "kb-1", title: "规则.md", version: 1, qualityStatus: "passed", kb: { name: "知识库", type: "platform" } },
    ]);

    process.env.DEEPSEEK_API_KEY = "test-key";
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
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
      expect((weknoraTrace!.data as any).node.status).toBe("success");
      expect((weknoraTrace!.data as any).node.summary).toContain("WeKnora 灰度对比完成");
      expect((weknoraTrace!.data as any).node.details.hybrid).toBe(false);
      expect((weknoraTrace!.data as any).node.details.overlapCount).toBe(1);
    } finally {
      (global as any).fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
});
