import { BrainCompilerService } from "./brain-compiler.service";

const mockPrisma: any = {
  knowledgeBase: { findMany: jest.fn() },
  user: { findMany: jest.fn() },

  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
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

  it('reads audit telemetry without traversing RLS-hidden required documents', async () => {
    const findSources = jest.fn(async (args: any) => {
      if (args.select) {
        // Prisma throws if this query selects documents.document under RLS.
        if (args.select.documents) throw new Error('required document relation hidden by RLS');
        return [
          { sourceKey: 'personal-source', kind: 'personal' },
          { sourceKey: 'legacy-private-source', kind: 'private' },
          { sourceKey: 'industry-source', kind: 'industry' },
        ];
      }
      return [{ sourceKey: 'industry-source', kind: 'industry', status: 'active', _count: { members: 2, documents: 3 } }];
    });
    const mockDb = {
      brainSource: { findMany: findSources },
      brainMaintenanceRun: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      brainScope: { findMany: jest.fn().mockResolvedValue([
        { id: 'private-scope', sourceKeys: ['personal-source'], _count: { members: 1, derivedPages: 1 } },
        { id: 'public-scope', sourceKeys: ['industry-source'], _count: { members: 2, derivedPages: 3 } },
      ]) },
      brainDerivedPage: { count: jest.fn().mockResolvedValue(3) },
      brainChangeEvent: { count: jest.fn().mockResolvedValue(0) },
      brainTopic: { count: jest.fn().mockResolvedValue(0) },
    };
    const queue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const service = new BrainCompilerService(queue as any, {} as any, {} as any, {} as any, {} as any);
    (service as any).prisma = mockDb;

    const telemetry = await service.getDreamTelemetry({ excludePrivate: true });

    expect(findSources).toHaveBeenNthCalledWith(1, {
      where: { status: 'active' }, select: { sourceKey: true, kind: true },
    });
    expect(findSources).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { status: 'active', kind: { notIn: ['personal', 'private'] } },
    }));
    expect(telemetry.sources.map((source: any) => source.sourceKey)).toEqual(['industry-source']);
    expect(telemetry.scopes.map((scope: any) => scope.id)).toEqual(['public-scope']);
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

describe('BrainCompilerService complete source replacement', () => {
  const fixture = (count: number) => {
    const docs = Array.from({ length: count }, (_, index) => ({ id: `doc-${String(index).padStart(4, '0')}`, kbId: 'kb', title: `Document ${index}`, version: 1, updatedAt: new Date(), chunks: [], kb: { name: 'KB', type: 'org' } }));
    const pages = new Set<string>(['docs/orphan']);
    const mappings = new Set<string>();
    const db = {
      brainSource: { upsert: jest.fn().mockResolvedValue({ id: 'source' }), update: jest.fn() },
      brainSourceDocument: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn(async (args: any) => { mappings.add(args.create.documentId); }), deleteMany: jest.fn() },
      document: { findMany: jest.fn(async (args: any) => {
        if (args.select) return docs;
        expect(args.orderBy).toEqual({ id: 'asc' });
        const start = args.cursor ? docs.findIndex(doc => doc.id === args.cursor.id) + 1 : 0;
        return docs.slice(start, start + args.take);
      }) },
    };
    const adapter = {
      initializeSource: jest.fn(),
      rebuild: jest.fn(async (_source: string, evidence: any[]) => { pages.clear(); evidence.forEach(item => pages.add(item.slug)); }),
      ingest: jest.fn(async (_source: string, evidence: any[]) => { evidence.forEach(item => pages.add(item.slug)); }),
    };
    const service = new BrainCompilerService({} as any, {} as any, {} as any, {} as any, {} as any, adapter as any);
    (service as any).prisma = db;
    const run = () => (service as any).syncSourceDefinition({ sourceKey: 'source', kind: 'org', scopeKey: 'kb:kb', kbIds: ['kb'] }, undefined, [], { forceFull: true });
    return { docs, pages, mappings, db, adapter, run };
  };
  it('resets once then adds the second batch, preserving all 501 pages and unique joins', async () => {
    const { run, adapter, pages, mappings, docs, db } = fixture(501);
    const result = await run();
    expect(result.synced).toBe(501);
    expect(adapter.rebuild).toHaveBeenCalledTimes(1);
    expect(adapter.rebuild.mock.calls[0][1]).toHaveLength(500);
    expect(adapter.ingest).toHaveBeenCalledTimes(1);
    expect(adapter.ingest.mock.calls[0][1]).toHaveLength(1);
    expect([...pages].sort()).toEqual(docs.map(doc => `docs/${doc.id}`));
    expect(mappings.size).toBe(501);
    expect(db.brainSourceDocument.upsert).toHaveBeenCalledTimes(501);
  });
  it('clears orphan pages when a full source inventory is empty', async () => {
    const { run, adapter, pages } = fixture(0);
    await run();
    expect(adapter.rebuild).toHaveBeenCalledWith('gbrain://source/source', []);
    expect(adapter.ingest).not.toHaveBeenCalled();
    expect(pages.size).toBe(0);
  });
});

describe("BrainCompilerService query freshness", () => {
  it('checks permissions once per selected-source request and rereads them on the next request', async () => {
    const permission = { getVisibleKnowledgeBases: jest.fn().mockResolvedValue(['kb-1']) };
    const service = new BrainCompilerService({} as any, permission as any, {} as any, {} as any, {} as any);
    const sourceKey = BrainCompilerService.sourceKeyForKnowledgeBase('kb-1');
    const db = {
      knowledgeBase: { findMany: jest.fn().mockResolvedValue([{ id: 'kb-1', type: 'org' }]) },
      document: { findMany: jest.fn().mockResolvedValue([{ kbId: 'kb-1' }]) },
      brainSource: { findMany: jest.fn().mockResolvedValue([{ id: 'source-id', sourceKey }]), upsert: jest.fn() },
      brainSourceMember: { findMany: jest.fn().mockResolvedValue([{ sourceId: 'source-id' }]), upsert: jest.fn(), deleteMany: jest.fn() },
    };
    (service as any).prisma = db;
    expect(await service.getUserSourceRefsForKnowledgeBases('user-1', ['kb-1'])).toEqual([`gbrain://source/${sourceKey}`]);
    expect(permission.getVisibleKnowledgeBases).toHaveBeenCalledTimes(1);
    expect(db.brainSourceMember.deleteMany).toHaveBeenCalled();
    permission.getVisibleKnowledgeBases.mockResolvedValue([]);
    db.knowledgeBase.findMany.mockResolvedValue([]);
    expect(await service.getUserSourceRefsForKnowledgeBases('user-1', ['kb-1'])).toEqual([]);
    expect(permission.getVisibleKnowledgeBases).toHaveBeenCalledTimes(2);
  });
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
      $executeRaw: jest.fn().mockResolvedValue(1),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
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


describe('Archived cleanup source guard', () => {
  it('does not resolve KB source, mutate GBrain or queue synthesis without document mapping', async () => {
    mockPrisma.brainSourceDocument = { findMany: jest.fn().mockResolvedValue([]) };
    mockPrisma.brainSource = { findUnique: jest.fn() };
    const queue = { add: jest.fn() };
    const adapter = { delete: jest.fn() };
    const service = new BrainCompilerService(queue as any, {} as any, {} as any, {} as any, {} as any, adapter as any);
    expect(await service.onKnowledgeDeleted('kb-1', 'doc-1', { requireMapping: true, deferSynthesis: true })).toEqual([]);
    expect(mockPrisma.brainSource.findUnique).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled(); expect(queue.add).not.toHaveBeenCalled();
  });
});
