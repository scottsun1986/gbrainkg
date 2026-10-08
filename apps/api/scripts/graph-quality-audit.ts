import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const kbId = process.argv[2];
  if (!kbId || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(kbId)) {
    throw new Error('Usage: graph-quality-audit.ts <kb UUID>; DATABASE_URL must point to the test database');
  }
  const db = new PrismaClient();
  try {
    const report = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$queryRaw`SELECT set_config('statement_timeout', '30000', true)`;
      const [entities, relations, aliasCollisions, duplicateProvenance] = await Promise.all([
        tx.$queryRaw`
          SELECT count(*)::int AS total,
            count(*) FILTER (WHERE properties->'docIds' IS NULL OR properties->'docIds' = '[]'::jsonb)::int AS no_source,
            count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(properties->'docIds')='array' THEN properties->'docIds' ELSE '[]'::jsonb END)>1)::int AS multi_source_identity_review
          FROM "GraphEntity" WHERE "kbId"=${kbId}::uuid`,
        tx.$queryRaw`
          WITH origins AS (
            SELECT r.id,p.value AS p,d.id AS doc,c.id AS chunk,d.version AS current_version
            FROM "GraphRelation" r
            LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.provenance)='array' THEN r.provenance ELSE '[]'::jsonb END) p ON true
            LEFT JOIN "Document" d ON d.id::text=p.value->>'documentId' AND d.status='published'
              AND (d."effectiveFrom" IS NULL OR d."effectiveFrom"<=statement_timestamp())
              AND (d."effectiveTo" IS NULL OR d."effectiveTo">statement_timestamp())
              AND (d."lifecycleStatus"<>'repealed' OR d."effectiveTo" IS NOT NULL)
            LEFT JOIN "Chunk" c ON c.id::text=p.value->>'chunkId' AND c."documentId"=d.id
            WHERE r."kbId"=${kbId}::uuid
          ) SELECT count(DISTINCT id)::int AS total,
            count(DISTINCT id) FILTER (WHERE p IS NULL OR p->>'documentId' IS NULL)::int AS no_source,
            count(DISTINCT id) FILTER (WHERE p IS NOT NULL AND (doc IS NULL OR chunk IS NULL OR p->>'documentVersion' IS DISTINCT FROM current_version::text))::int AS stale_or_missing_origin
          FROM origins`,
        tx.$queryRaw`
          SELECT lower(a.value) AS alias, array_agg(DISTINCT e.id::text) AS entity_ids
          FROM "GraphEntity" e, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.aliases)='array' THEN e.aliases ELSE '[]'::jsonb END) a
          WHERE e."kbId"=${kbId}::uuid GROUP BY lower(a.value) HAVING count(DISTINCT e.id)>1
          ORDER BY count(DISTINCT e.id) DESC LIMIT 50`,
        tx.$queryRaw`
          SELECT r.id::text, count(*)::int AS duplicate_count
          FROM "GraphRelation" r, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.provenance)='array' THEN r.provenance ELSE '[]'::jsonb END) p
          WHERE r."kbId"=${kbId}::uuid GROUP BY r.id,p.value->>'documentId',p.value->>'chunkId',p.value->>'documentVersion' HAVING count(*)>1 ORDER BY count(*) DESC LIMIT 50`,
      ]);
      return { schemaVersion: 1, kbId, entities, relations, aliasCollisions, duplicateProvenance,
        identityReview: 'Alias collisions and multi-source names are review candidates, not proof of incorrect merges.' };
    }, { timeout: 35000, maxWait: 5000 });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { await db.$disconnect(); }
}
main().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
