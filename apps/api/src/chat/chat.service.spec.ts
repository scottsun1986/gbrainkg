import { Test, TestingModule } from "@nestjs/testing";
import { ChatService } from "./chat.service";
import { PermissionService } from "../permission/permission.service";
import { BrainCompilerService } from "../brain-compiler/brain-compiler.service";
import { BrainScopeService } from "../brain-compiler/brain-scope.service";
import { lastValueFrom, toArray } from "rxjs";

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
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
        { breadth: true, operation: "query" },
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
});
