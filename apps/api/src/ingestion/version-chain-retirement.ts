/**
 * Cross-document version-chain retirement (B02).
 *
 * A superseding version used to retire its predecessor at creation time, so a
 * parse failure, a held-for-review version or a lost queue job opened a window
 * where neither version served retrieval. Retirement now runs inside the
 * successor's successful publish transaction (DocumentVersionStore.publish for
 * versioned publications, the legacy source-sync publish for non-versioned
 * ones): the predecessor keeps serving until the replacement is actually live,
 * and the switch happens exactly once.
 *
 * The walk is transitive: a replacement may be created from a FAILED
 * intermediate version (the recovery path), so publishing the newest
 * replacement must retire every reachable predecessor in the chain, not just
 * the direct one — otherwise the failed link's own predecessor would stay
 * current alongside the new version.
 *
 * `translation` links never retire the original: a translation is a parallel
 * representation of the same knowledge, not a replacement, so both stay
 * current (the relation semantics are explicit instead of every link being
 * unconditionally treated as supersedes).
 */
export async function retireSupersededPredecessors(tx: any, documentId: string): Promise<number> {
  const predecessorIds: string[] = [];
  const seen = new Set<string>([documentId]);
  const queue = [documentId];
  while (queue.length) {
    const current = queue.shift()!;
    const links: Array<{ fromDocumentId: string }> = await tx.documentVersionLink.findMany({
      where: { toDocumentId: current, relation: { not: 'translation' } },
      select: { fromDocumentId: true },
    });
    for (const link of links ?? []) {
      if (!seen.has(link.fromDocumentId)) {
        seen.add(link.fromDocumentId);
        predecessorIds.push(link.fromDocumentId);
        queue.push(link.fromDocumentId);
      }
    }
  }
  if (!predecessorIds.length) return 0;
  // A predecessor with a future effectiveTo keeps its scheduled window: the
  // COALESCE mirrors the previous `effectiveTo ?? now()` semantics instead of
  // shortening an explicitly planned validity interval.
  const retired: number = await tx.$executeRaw`
    UPDATE "Document"
    SET "lifecycleStatus" = 'superseded',
        "effectiveTo" = COALESCE("effectiveTo", now())
    WHERE id = ANY(${predecessorIds}::uuid[])
      AND "lifecycleStatus" = 'current'
  `;
  return Number(retired) || 0;
}
