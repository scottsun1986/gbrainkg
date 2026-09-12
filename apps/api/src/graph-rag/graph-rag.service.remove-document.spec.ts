import { GraphRagService } from './graph-rag.service';

const executeRaw = jest.fn();

const mockPrisma = {
  $executeRaw: executeRaw,
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));

describe('GraphRagService.removeDocumentFromGraph', () => {
  const KB = '11111111-1111-4111-8111-111111111111';
  const DOC = '22222222-2222-4222-8222-222222222222';
  let service: GraphRagService;

  beforeEach(() => {
    jest.clearAllMocks();
    executeRaw.mockReset();
    service = new GraphRagService();
    (service as any).prisma = mockPrisma;
  });

  /** Raw SQL skeleton of a tagged-template call (static parts joined). */
  const sqlOf = (callIndex: number): string =>
    executeRaw.mock.calls[callIndex][0].join(' ');

  /** Bound parameters of a tagged-template call. */
  const argsOf = (callIndex: number): any[] =>
    executeRaw.mock.calls[callIndex].slice(1);

  it('deletes relations via provenance containment first, then prunes orphan entities', async () => {
    executeRaw.mockResolvedValueOnce(4).mockResolvedValueOnce(3);

    const res = await service.removeDocumentFromGraph(KB, DOC);

    expect(res).toEqual({ relationsRemoved: 4, entitiesRemoved: 3 });
    expect(executeRaw).toHaveBeenCalledTimes(2);

    // Step 1: relation delete scoped to the KB, matching the documentId
    // inside the JSONB provenance array.
    const relationSql = sqlOf(0);
    expect(relationSql).toContain('DELETE FROM "GraphRelation"');
    expect(relationSql).toContain('"kbId"');
    expect(relationSql).toContain('provenance');
    expect(relationSql).toContain('@>');
    const relationArgs = argsOf(0);
    expect(relationArgs).toContain(KB);
    expect(relationArgs).toContain(JSON.stringify([{ documentId: DOC }]));

    // Step 2: entity delete only afterwards, via NOT EXISTS orphan check.
    const entitySql = sqlOf(1);
    expect(entitySql).toContain('DELETE FROM "GraphEntity"');
    expect(entitySql).toContain('"kbId"');
    expect(entitySql).toContain('NOT EXISTS');
    expect(entitySql).toContain('docIds');
    expect(entitySql).toContain('jsonb_array_elements_text');
    const entityArgs = argsOf(1);
    expect(entityArgs).toContain(KB);
    expect(entityArgs).toContain(DOC);

    // Relation cleanup must be issued before the entity cleanup.
    expect(sqlOf(0)).toContain('GraphRelation');
    expect(sqlOf(1)).not.toContain('DELETE FROM "GraphRelation"');
  });

  it('returns zeroes and still runs both idempotent deletes when nothing matches', async () => {
    executeRaw.mockResolvedValue(0);

    const res = await service.removeDocumentFromGraph(KB, DOC);

    expect(res).toEqual({ relationsRemoved: 0, entitiesRemoved: 0 });
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('swallows a failure in the relation phase and skips the orphan cleanup', async () => {
    executeRaw.mockRejectedValueOnce(new Error('relation delete failed'));

    await expect(
      service.removeDocumentFromGraph(KB, DOC),
    ).resolves.toEqual({ relationsRemoved: 0, entitiesRemoved: 0 });

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps the partial relation count when the orphan phase fails', async () => {
    executeRaw
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(new Error('entity delete failed'));

    const res = await service.removeDocumentFromGraph(KB, DOC);

    expect(res).toEqual({ relationsRemoved: 2, entitiesRemoved: 0 });
  });
});
