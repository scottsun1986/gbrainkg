export interface DeterministicChunk {
  id: string;
  documentId: string;
  kbId: string;
  ord: number;
  content: string;
  metadata: any;
}

/** Complete scan of an already scoped predicate. One snapshot prevents mixed
 * publication versions; keyset paging avoids OFFSET's growing scan cost. */
export async function scanDeterministicChunks(
  prisma: any, where: any, cap: number, pageSize = 2000,
): Promise<DeterministicChunk[]> {
  if (!Number.isInteger(cap) || cap < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error('Invalid deterministic scan budget');
  }
  return prisma.$transaction(async (tx: any) => {
    const expected = await tx.chunk.count({ where });
    if (!expected || expected > cap) return [];
    const rows: DeterministicChunk[] = [];
    let last: DeterministicChunk | undefined;
    while (rows.length < expected) {
      const after = last ? { OR: [
        { documentId: { gt: last.documentId } },
        { documentId: last.documentId, ord: { gt: last.ord } },
        { documentId: last.documentId, ord: last.ord, id: { gt: last.id } },
      ] } : undefined;
      const take = Math.min(pageSize, expected - rows.length);
      const page: DeterministicChunk[] = await tx.chunk.findMany({
        where: after ? { AND: [where, after] } : where,
        orderBy: [{ documentId: 'asc' }, { ord: 'asc' }, { id: 'asc' }],
        take,
        select: { id: true, documentId: true, kbId: true, ord: true, content: true, metadata: true },
      });
      // The caller renders an honest unavailable/partial response from [].
      // Never expose a purported full enumeration from a broken source scan.
      if (page.length !== take) return [];
      const next = page[page.length - 1];
      if (last && next.id === last.id) return [];
      rows.push(...page);
      last = next;
    }
    return rows;
  }, { isolationLevel: 'RepeatableRead', timeout: 120000 });
}
