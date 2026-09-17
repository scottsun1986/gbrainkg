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

