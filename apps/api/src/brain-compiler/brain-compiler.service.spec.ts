import { BrainCompilerService } from "./brain-compiler.service";

const mockPrisma = {
  knowledgeBase: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));

jest.mock("@llmwiki/gbrain-adapter", () => ({
  BrainRepoAdapter: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("./canonical-document", () => ({
  readCanonicalDocument: jest.fn().mockResolvedValue("canonical text"),
  mergeStoredChunks: jest.fn().mockReturnValue("merged"),
}));

describe("BrainCompilerService source isolation", () => {
  it("keeps one stable source per knowledge base regardless of audience changes", async () => {
    const permission = {
      getVisibleKnowledgeBases: jest
        .fn()
        .mockResolvedValue(["kb-a", "kb-b", "kb-all"]),
      getUsersVisibleToKnowledgeBase: jest.fn(async (kbId: string) =>
        kbId === "kb-all" ? ["u3", "u1", "u2"] : ["u2", "u1"],
      ),
    };
    mockPrisma.knowledgeBase.findMany.mockResolvedValue([
      { id: "kb-a", type: "industry" },
      { id: "kb-b", type: "org" },
      { id: "kb-all", type: "industry" },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "u1" },
      { id: "u2" },
      { id: "u3" },
    ]);
    const service = new BrainCompilerService(
      {} as any,
      permission as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const plan = await (service as any).getSourcePlan("u1");

    expect(plan).toHaveLength(3);
    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: expect.stringMatching(/^llmwiki-kb-[a-f0-9]{16}$/),
          kind: "industry",
          kbIds: ["kb-all"],
        }),
        expect.objectContaining({
          kind: "industry",
          scopeKey: "kb:kb-a",
          kbIds: ["kb-a"],
        }),
        expect.objectContaining({
          kind: "org",
          scopeKey: "kb:kb-b",
          kbIds: ["kb-b"],
        }),
      ]),
    );
    expect(permission.getUsersVisibleToKnowledgeBase).not.toHaveBeenCalled();
  });

  it("handles undefined or null jobs in compilerQueue.getJobs without crashing", async () => {
    const mockDb = {
      brainSource: { findMany: jest.fn().mockResolvedValue([]) },
      brainMaintenanceRun: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      brainScope: { findMany: jest.fn().mockResolvedValue([]) },
      brainDerivedPage: { count: jest.fn().mockResolvedValue(0) },
      brainChangeEvent: { count: jest.fn().mockResolvedValue(0) },
      brainOperationLog: { findMany: jest.fn().mockResolvedValue([]) },
      brainTopic: { count: jest.fn().mockResolvedValue(0) },
    };
    const mockQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 1, delayed: 0 }),
      getJobs: jest.fn().mockResolvedValue([
        undefined,
        null,
        { id: "job-1", name: "other-job" },
        { id: "job-2", name: "gbrain-maintenance", failedReason: "test timeout", attemptsMade: 2, timestamp: 123456 },
      ]),
    };
    const service = new BrainCompilerService(
      mockQueue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (service as any).prisma = mockDb;

    const telemetry = await service.getDreamTelemetry();

    expect(telemetry.maintenanceFailures).toEqual([
      {
        id: "job-2",
        failedReason: "test timeout",
        attemptsMade: 2,
        timestamp: 123456,
      },
    ]);
  });
});

describe("BrainCompilerService coalesced source sync", () => {
  const buildService = (queue: any, docVersion = 1) => {
    const service = new BrainCompilerService(
      queue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (service as any).prisma = {
      document: { findUnique: jest.fn().mockResolvedValue({ version: docVersion }) },
    };
    return service;
  };

  it("creates one delayed coalesced job for the first publish", async () => {
    const added: any[] = [];
    const queue = {
      getJob: jest.fn().mockResolvedValue(undefined),
      add: jest.fn(async (name: string, data: any, opts: any) => {
        added.push({ name, data, opts });
        return { id: opts.jobId };
      }),
    };
    const service = buildService(queue);

    await service.onKnowledgePublished("kb-1", "doc-1", ["t"]);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(added[0].opts.jobId).toMatch(/^source-sync-/);
    expect(added[0].data.docIds).toEqual(["doc-1"]);
    expect(added[0].opts.delay).toBeGreaterThanOrEqual(0);
  });

  it("merges an additional publish into the pending job instead of adding a new one", async () => {
    const updateData = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: { kbId: "kb-1", docIds: ["doc-1"], topics: ["t"] },
      getState: jest.fn().mockResolvedValue("delayed"),
      updateData,
      promote: jest.fn().mockResolvedValue(undefined),
    };
    const queue = { getJob: jest.fn().mockResolvedValue(job), add: jest.fn() };
    const service = buildService(queue);

    await service.onKnowledgePublished("kb-1", "doc-2", ["t"]);

    expect(queue.add).not.toHaveBeenCalled();
    expect(updateData).toHaveBeenCalledWith(
      expect.objectContaining({ docIds: ["doc-1", "doc-2"] }),
    );
  });

  it("enqueues a unique follow-up when a source sync is already active", async () => {
    const added: any[] = [];
    const job = {
      data: { kbId: "kb-1", docIds: ["doc-1"], topics: [] },
      getState: jest.fn().mockResolvedValue("active"),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(job),
      add: jest.fn(async (name: string, data: any, opts: any) => {
        added.push({ name, data, opts });
      }),
    };
    const service = buildService(queue);

    await service.onKnowledgePublished("kb-1", "doc-2", []);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(added[0].data.docIds).toEqual(["doc-2"]);
    expect(added[0].opts.jobId).toContain("doc-2");
  });

  it("uses the incremental path for a materialized source and skips the full inventory scan", async () => {
    const db = {
      brainSource: {
        upsert: jest.fn().mockResolvedValue({ id: "source-1" }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      brainSourceDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue(undefined),
        deleteMany: jest.fn().mockResolvedValue(undefined),
      },
    };
    const gbrain = {
      initializeSource: jest.fn().mockResolvedValue(undefined),
      isSourceMaterialized: jest.fn().mockResolvedValue(true),
      ingest: jest.fn().mockResolvedValue(undefined),
      rebuild: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      document: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "doc-1",
            kbId: "kb-1",
            version: 1,
            updatedAt: new Date(),
            title: "doc-1",
            chunks: [],
            kb: { name: "KB", type: "org" },
          },
        ]),
      },
      ...db,
    };
    const service = new BrainCompilerService({} as any, {} as any, {} as any, {} as any, {} as any);
    (service as any).prisma = prisma;
    (service as any).gbrain = gbrain;

    await (service as any).syncSourceDefinition(
      { sourceKey: "sk", kind: "org", scopeKey: "kb:kb-1", kbIds: ["kb-1"] },
      undefined,
      ["doc-1"],
    );

    expect(gbrain.isSourceMaterialized).toHaveBeenCalledTimes(1);
    // Stale/version bookkeeping scans must be skipped on the incremental path.
    expect(db.brainSourceDocument.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany.mock.calls[0][0].where.id).toEqual({ in: ["doc-1"] });
    expect(gbrain.ingest).toHaveBeenCalledTimes(1);
    expect(db.brainSourceDocument.upsert).toHaveBeenCalledTimes(1);
  });

  it("falls back to the full reconcile scan when the source is not materialized", async () => {
    const db = {
      brainSource: {
        upsert: jest.fn().mockResolvedValue({ id: "source-1" }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      brainSourceDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue(undefined),
        deleteMany: jest.fn().mockResolvedValue(undefined),
      },
    };
    const gbrain = {
      initializeSource: jest.fn().mockResolvedValue(undefined),
      isSourceMaterialized: jest.fn().mockResolvedValue(false),
      ingest: jest.fn().mockResolvedValue(undefined),
      rebuild: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      document: { findMany: jest.fn().mockResolvedValue([]) },
      ...db,
    };
    const service = new BrainCompilerService({} as any, {} as any, {} as any, {} as any, {} as any);
    (service as any).prisma = prisma;
    (service as any).gbrain = gbrain;

    await (service as any).syncSourceDefinition(
      { sourceKey: "sk", kind: "org", scopeKey: "kb:kb-1", kbIds: ["kb-1"] },
      undefined,
      ["doc-1"],
    );

    expect(db.brainSourceDocument.findMany).toHaveBeenCalledTimes(1);
    const firstWhere = prisma.document.findMany.mock.calls[0][0].where;
    expect(firstWhere.id).toBeUndefined();
    expect(firstWhere.kbId).toEqual({ in: ["kb-1"] });
  });
});

describe("BrainCompilerService query freshness", () => {
  it("checks a large source with aggregate SQL instead of loading all documents and mappings", async () => {
    const queue = { add: jest.fn() };
    const outbox = { logOperation: jest.fn() };
    const service = new BrainCompilerService(
      queue as any,
      {} as any,
      {} as any,
      {} as any,
      outbox as any,
    );
    const findMany = jest.fn();
    const findMappings = jest.fn();
    const prisma = {
      document: { findMany, count: jest.fn() },
      brainSource: {
        findUnique: jest.fn().mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" }),
      },
      brainSourceDocument: { findMany: findMappings },
      $queryRaw: jest.fn().mockResolvedValue([
        { publishedCount: BigInt(100_000), mappingStale: false },
      ]),
    };
    (service as any).prisma = prisma;
    (service as any).getSourcePlan = jest.fn().mockResolvedValue([
      { sourceKey: "source-1", kind: "org", scopeKey: "kb:kb-1", kbIds: ["kb-1"] },
    ]);
    (service as any).gbrain = {
      getSourcePageCounts: jest.fn().mockResolvedValue(new Map([["source-1", 100_000]])),
    };

    await expect(service.ensureSourcesFreshForQuery("user-1", ["kb-1"])).resolves.toEqual({
      checked: 1,
      rebuilt: 0,
      fresh: true,
      staleSources: [],
      sourceKeys: ["source-1"],
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(findMappings).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
