import { Test, TestingModule } from "@nestjs/testing";
import { BrainCompilerProcessor } from "./brain-compiler.processor";
import { Job } from "bullmq";
import { PermissionService } from "../permission/permission.service";
import { ModelConfigService } from "../model-config.service";
import { BrainCompilerService } from "./brain-compiler.service";
import { BrainScopeService } from "./brain-scope.service";
import { BrainOutboxService } from "./brain-outbox.service";

const mockPrisma = {
  brainRepo: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  brainTopic: {
    upsert: jest.fn(),
    update: jest.fn(),
  },
  document: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
};

const mockGbrainAdapter = {
  ingest: jest.fn(),
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));

jest.mock("@llmwiki/gbrain-adapter", () => ({
  BrainRepoAdapter: jest.fn().mockImplementation(() => mockGbrainAdapter),
}));

describe("BrainCompilerProcessor", () => {
  let processor: BrainCompilerProcessor;
  const permissionService = {
    getVisibleKnowledgeBases: jest.fn().mockResolvedValue([]),
  };
  const modelConfigService = {
    applyRuntimeConfig: jest.fn().mockResolvedValue(undefined),
  };
  const compilerService = {
    syncSourceIncremental: jest
      .fn()
      .mockResolvedValue({ synced: 1, removed: 0 }),
    reconcileAccess: jest.fn().mockResolvedValue({}),
    runDreamCycle: jest.fn().mockResolvedValue({}),
    syncKnowledgeBaseSource: jest.fn(),
    invalidateScopesForSource: jest.fn(),
    queueScopeSynthesis: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrainCompilerProcessor,
        { provide: PermissionService, useValue: permissionService },
        { provide: ModelConfigService, useValue: modelConfigService },
        { provide: BrainCompilerService, useValue: compilerService },
        { provide: BrainScopeService, useValue: {} },
        { provide: BrainOutboxService, useValue: { logOperation: jest.fn() } },
      ],
    }).compile();

    processor = module.get<BrainCompilerProcessor>(BrainCompilerProcessor);
    jest.clearAllMocks();
  });

  it("should process a dirty job through READ, GATHER, WRITE, SYNC", async () => {
    const mockJob = {
      data: {
        userId: "user-1",
        topicSlug: "安全合规",
        source: "knowledge_publish",
      },
    } as Job;

    // READ Mock
    mockPrisma.brainRepo.findUnique.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });

    // WRITE Mock
    mockGbrainAdapter.ingest.mockResolvedValue(undefined);

    // SYNC Mock
    mockPrisma.brainTopic.upsert.mockResolvedValue({});

    const result = await processor.process(mockJob);

    // 断言四个阶段都被正确调用
    expect(mockPrisma.brainRepo.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(mockGbrainAdapter.ingest).toHaveBeenCalled();
    expect(mockPrisma.brainTopic.upsert).toHaveBeenCalledWith({
      where: {
        brainRepoId_topicSlug: { brainRepoId: "repo-1", topicSlug: "安全合规" },
      },
      create: expect.objectContaining({ topicSlug: "安全合规" }),
      update: expect.objectContaining({ compileStatus: "clean" }),
    });
    expect(result).toEqual({ status: "success", topicSlug: "安全合规" });
  });

  it("publishes a source-scoped document after successful incremental sync", async () => {
    const mockJob = {
      data: {
        userId: "user-1",
        topicSlug: "制度",
        source: "document_upload",
        sourceKey: "llmwiki-scope-test",
        docIds: ["doc-1"],
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as Job;

    mockPrisma.brainRepo.findUnique.mockResolvedValue({
      id: "repo-1",
      gitRepoUrl: "/tmp/repo",
    });
    mockPrisma.document.findMany.mockResolvedValue([]);

    await expect(processor.process(mockJob)).resolves.toEqual({
      status: "success",
      topicSlug: "制度",
    });
    expect(compilerService.syncSourceIncremental).toHaveBeenCalledWith(
      "llmwiki-scope-test",
      "user-1",
      ["doc-1"],
    );
    expect(mockPrisma.document.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["doc-1"] }, status: "indexing" },
      data: { status: "published" },
    });
  });

  it("syncs one stable knowledge-base source and then invalidates affected scopes", async () => {
    const mockJob = {
      name: "source-sync",
      data: { kbId: "kb-1", docIds: ["doc-1"] },
    } as Job;
    compilerService.syncKnowledgeBaseSource.mockResolvedValue({
      sourceKey: "llmwiki-kb-stable",
      synced: 1,
      removed: 0,
    });
    compilerService.invalidateScopesForSource.mockResolvedValue(["scope-1"]);
    compilerService.queueScopeSynthesis.mockResolvedValue(undefined);

    await expect(processor.process(mockJob)).resolves.toEqual({
      status: "success",
      sourceKey: "llmwiki-kb-stable",
      synced: 1,
      removed: 0,
      affectedScopes: 1,
    });
    expect(compilerService.syncKnowledgeBaseSource).toHaveBeenCalledWith("kb-1", ["doc-1"]);
    expect(mockPrisma.document.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["doc-1"] }, status: "indexing" },
      data: { status: "published" },
    });
    expect(compilerService.invalidateScopesForSource).toHaveBeenCalledWith("llmwiki-kb-stable");
    expect(compilerService.queueScopeSynthesis).toHaveBeenCalledWith(["scope-1"], 3);
  });
});
