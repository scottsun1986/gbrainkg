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
  it("groups KBs by exact effective audience and keeps all-user knowledge shared", async () => {
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
    );

    const plan = await (service as any).getSourcePlan("u1");

    expect(plan).toHaveLength(2);
    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: "llmwiki-shared",
          kind: "shared",
          kbIds: ["kb-all"],
        }),
        expect.objectContaining({
          kind: "private",
          scopeKey: "u1,u2",
          kbIds: ["kb-a", "kb-b"],
        }),
      ]),
    );
  });
});
