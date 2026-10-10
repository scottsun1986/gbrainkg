import { Test, TestingModule } from "@nestjs/testing";
import { BrainCompilerProcessor } from "./brain-compiler.processor";
import { Job } from "bullmq";
import { PermissionService } from "../permission/permission.service";
import { ModelConfigService } from "../model-config.service";
import { BrainCompilerService } from "./brain-compiler.service";
import { BrainScopeService } from "./brain-scope.service";
import { BrainOutboxService } from "./brain-outbox.service";
import { ChunkEmbeddingService } from "../embedding/chunk-embedding.service";

const mockPrisma: any = {
  knowledgeBase: { findUnique: jest.fn() },
  brainChangeEvent: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
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
  documentVersionLink: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),

  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};

const mockGbrainAdapter = {
  ingest: jest.fn(),
};

const chunkEmbedding = {
  isEnabled: jest.fn().mockReturnValue(false),
  documentCoverage: jest.fn(),
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
    mockPrisma.knowledgeBase.findUnique.mockResolvedValue({ status: 'active' });
    chunkEmbedding.isEnabled.mockReturnValue(false);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrainCompilerProcessor,
        { provide: PermissionService, useValue: permissionService },
        { provide: ModelConfigService, useValue: modelConfigService },
        { provide: BrainCompilerService, useValue: compilerService },
        { provide: BrainScopeService, useValue: {} },
        { provide: BrainOutboxService, useValue: { logOperation: jest.fn() } },
        { provide: ChunkEmbeddingService, useValue: chunkEmbedding },
      ],
    }).compile();

    processor = module.get<BrainCompilerProcessor>(BrainCompilerProcessor);
    jest.clearAllMocks();
  });

  it('does not repeat side effects for a completed outbox event', async () => {
    mockPrisma.brainChangeEvent.findUnique.mockResolvedValue({ id: 'event-1', status: 'completed', eventType: 'doc_change' });
    const result = await processor.process({ name: 'process-outbox-event', data: { eventId: 'event-1' } } as Job);
    expect(result).toMatchObject({ status: 'skipped', reason: 'Event already completed' });
    expect(mockPrisma.brainChangeEvent.update).not.toHaveBeenCalled();
    expect(compilerService.syncKnowledgeBaseSource).not.toHaveBeenCalled();
    expect(compilerService.reconcileAccess).not.toHaveBeenCalled();
  });

  it('refuses to mutate an unfinished event after losing the queue lease', async () => {
    mockPrisma.brainChangeEvent.findUnique.mockResolvedValue({ id: 'event-1', status: 'pending', eventType: 'perm_revoke' });
    const job = { id: 'outbox-event-event-1', name: 'process-outbox-event', data: { eventId: 'event-1' }, extendLock: jest.fn().mockResolvedValue(0) };
    await expect(processor.process(job as any, 'expired-token')).rejects.toThrow('BullMQ lease');
    expect(mockPrisma.brainChangeEvent.updateMany).not.toHaveBeenCalled();
    expect(compilerService.reconcileAccess).not.toHaveBeenCalled();
  });

  it('fences completion with both the queue lease and the atomic database claim token', async () => {
    mockPrisma.brainChangeEvent.findUnique.mockResolvedValue({ id: 'event-1', status: 'processing', claimToken: 'old-token', eventType: 'unknown' });
    mockPrisma.brainChangeEvent.updateMany.mockResolvedValue({ count: 1 });
    const job = { id: 'outbox-event-event-1', name: 'process-outbox-event', data: { eventId: 'event-1' }, extendLock: jest.fn().mockResolvedValue(1) };
    await expect(processor.process(job as any, 'new-token')).resolves.toMatchObject({ status: 'success' });
    expect(job.extendLock).toHaveBeenCalledTimes(2);
    expect(mockPrisma.brainChangeEvent.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'event-1', status: 'processing', claimToken: 'new-token' },
      data: expect.objectContaining({ status: 'completed', claimToken: null }),
    }));
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

  it("retires cross-document chain predecessors together with the legacy publish (B02)", async () => {
    compilerService.syncKnowledgeBaseSource.mockResolvedValue({
      sourceKey: "llmwiki-kb-stable",
      synced: 1,
      removed: 0,
    });
    compilerService.invalidateScopesForSource.mockResolvedValue([]);
    compilerService.queueScopeSynthesis.mockResolvedValue(undefined);
    mockPrisma.documentVersionLink.findMany.mockResolvedValueOnce([{ fromDocumentId: "doc-old" }]);

    await processor.process({
      name: "source-sync", data: { kbId: "kb-1", docIds: ["doc-new"] },
    } as Job);

    expect(mockPrisma.documentVersionLink.findMany).toHaveBeenCalledWith({
      where: { toDocumentId: "doc-new", relation: { not: "translation" } },
      select: { fromDocumentId: true },
    });
    const retireCall = mockPrisma.$executeRaw.mock.calls.map((call: any[]) => call[0]).find((raw: any) => String((raw?.strings ?? raw ?? []).join("")).includes(`'superseded'`));
    expect(retireCall).toBeTruthy();
  });

  it('completes stale source-sync jobs for archived knowledge bases without retrying', async () => {
    mockPrisma.knowledgeBase.findUnique.mockResolvedValue({ status: 'archived' });
    const result = await processor.process({
      name: 'source-sync', data: { kbId: 'kb-archived', docIds: ['doc-old'] },
    } as Job);
    expect(result).toEqual({ status: 'skipped', reason: 'knowledge-base-unavailable' });
    expect(compilerService.syncKnowledgeBaseSource).not.toHaveBeenCalled();
  });

  describe("core-indexing gate for source publish", () => {
    const sourceSyncJob = (docIds: string[] = ["doc-1"]) =>
      ({ name: "source-sync", data: { kbId: "kb-1", docIds } } as Job);

    it("defers publish when required chunks lack embeddings", async () => {
      chunkEmbedding.isEnabled.mockReturnValue(true);
      mockPrisma.document.findMany.mockResolvedValue([
        { id: "doc-1", indexReadiness: "pending" },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'doc-1', total: 10n, missing: 4n }]);

      await expect(processor.process(sourceSyncJob())).rejects.toThrow(
        /core indexing incomplete: doc-1 \(4\/10/,
      );
      expect(compilerService.syncKnowledgeBaseSource).not.toHaveBeenCalled();
      expect(mockPrisma.document.updateMany).not.toHaveBeenCalled();
    });

    it("publishes without a coverage query when indexReadiness is ready", async () => {
      chunkEmbedding.isEnabled.mockReturnValue(true);
      mockPrisma.document.findMany.mockResolvedValue([
        { id: "doc-1", indexReadiness: "ready" },
      ]);
      compilerService.syncKnowledgeBaseSource.mockResolvedValue({
        sourceKey: "src",
        synced: 1,
        removed: 0,
      });
      compilerService.invalidateScopesForSource.mockResolvedValue([]);
      compilerService.queueScopeSynthesis.mockResolvedValue(undefined);

      await expect(processor.process(sourceSyncJob())).resolves.toMatchObject({
        status: "success",
      });
      expect(chunkEmbedding.documentCoverage).not.toHaveBeenCalled();
      expect(mockPrisma.document.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["doc-1"] }, status: "indexing" },
        data: { status: "published" },
      });
    });

    it("publishes once the coverage query reports no missing chunks", async () => {
      chunkEmbedding.isEnabled.mockReturnValue(true);
      mockPrisma.document.findMany.mockResolvedValue([
        { id: "doc-1", indexReadiness: "enriching" },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'doc-1', total: 10n, missing: 0n }]);
      compilerService.syncKnowledgeBaseSource.mockResolvedValue({
        sourceKey: "src",
        synced: 1,
        removed: 0,
      });
      compilerService.invalidateScopesForSource.mockResolvedValue([]);
      compilerService.queueScopeSynthesis.mockResolvedValue(undefined);

      await expect(processor.process(sourceSyncJob())).resolves.toMatchObject({
        status: "success",
      });
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("skips the gate when the embedding service is disabled", async () => {
      chunkEmbedding.isEnabled.mockReturnValue(false);
      compilerService.syncKnowledgeBaseSource.mockResolvedValue({
        sourceKey: "src",
        synced: 1,
        removed: 0,
      });
      compilerService.invalidateScopesForSource.mockResolvedValue([]);
      compilerService.queueScopeSynthesis.mockResolvedValue(undefined);

      await expect(processor.process(sourceSyncJob())).resolves.toMatchObject({
        status: "success",
      });
      expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
      expect(chunkEmbedding.documentCoverage).not.toHaveBeenCalled();
    });

    it("skips the gate for full-source maintenance syncs without doc ids", async () => {
      chunkEmbedding.isEnabled.mockReturnValue(true);
      compilerService.syncKnowledgeBaseSource.mockResolvedValue({
        sourceKey: "src",
        synced: 2,
        removed: 0,
      });
      compilerService.invalidateScopesForSource.mockResolvedValue([]);
      compilerService.queueScopeSynthesis.mockResolvedValue(undefined);

      await expect(processor.process(sourceSyncJob([]))).resolves.toMatchObject({
        status: "success",
      });
      expect(chunkEmbedding.documentCoverage).not.toHaveBeenCalled();
      expect(compilerService.syncKnowledgeBaseSource).toHaveBeenCalledWith("kb-1", [], true);
    });
  });
});
