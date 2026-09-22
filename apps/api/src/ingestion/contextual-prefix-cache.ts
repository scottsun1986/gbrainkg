import { Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { ContextualPrefixCache } from './contextual-retrieval';
import { withServiceContext } from '../db/tenant-context.service';

/**
 * Durable (PostgreSQL-backed) cache for Contextual Retrieval prefixes.
 *
 * Contextual Retrieval costs one LLM call per chunk. Every re-ingest path used
 * to pay that bill again in full — a version bump, a BullMQ retry after an
 * unrelated enrichment failure, a duplicate upload of an unchanged file, or a
 * deliberate reindex. The prefixes are a pure function of (model, prompt,
 * chunk text, neighbouring window), so they are safe to memoize across
 * processes, restarts and instances.
 *
 * Keys are the SHA-256 of the exact request payload (see contextualRequestKey),
 * so a prompt or window change can never replay a stale prefix.
 */
export class PrismaContextualPrefixCache implements ContextualPrefixCache {
  private readonly logger = new Logger(PrismaContextualPrefixCache.name);
  private readonly retentionDays = Number(process.env.CONTEXTUAL_RETRIEVAL_CACHE_RETENTION_DAYS || 90);
  private prismaInstance?: ReturnType<typeof getPrismaClient>;

  /**
   * Resolve the client lazily so constructing the cache never opens a
   * connection (and never runs at module-import time, which would break
   * dependency-injected tests and slow down boot).
   */
  private get prisma(): any {
    if (!this.prismaInstance) this.prismaInstance = getPrismaClient();
    return this.prismaInstance;
  }

  async get(keys: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const unique = Array.from(new Set(keys.filter(Boolean)));
    if (!unique.length) return result;
    try {
      const rows: any[] = await withServiceContext(this.prisma, (tx) =>
        (tx as any).$queryRaw`
        SELECT "key", "value" FROM "ContextualPrefixCache" WHERE "key" = ANY(${unique}::text[])
      `);
      for (const row of rows || []) result.set(String(row.key), String(row.value));
      if (result.size) {
        // Best-effort bookkeeping so operators can see how much the cache saves.
        void withServiceContext(this.prisma, (tx) =>
          (tx as any).$executeRaw`
          UPDATE "ContextualPrefixCache"
          SET "hitCount" = "hitCount" + 1, "lastUsedAt" = CURRENT_TIMESTAMP
          WHERE "key" = ANY(${Array.from(result.keys())}::text[])
        `).catch(() => undefined);
      }
    } catch (err) {
      this.logger.debug(
        `Contextual prefix cache lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result;
  }

  async put(entries: Array<{ key: string; value: string }>): Promise<void> {
    const rows = entries.filter((entry) => entry?.key && entry?.value);
    if (!rows.length) return;
    try {
      await withServiceContext(this.prisma, (tx) =>
        (tx as any).$executeRaw`
        INSERT INTO "ContextualPrefixCache" ("key", "value", "createdAt", "lastUsedAt", "hitCount")
        SELECT t.key, t.value, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0
        FROM unnest(${rows.map((r) => r.key)}::text[], ${rows.map((r) => r.value)}::text[]) AS t(key, value)
        ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "lastUsedAt" = CURRENT_TIMESTAMP
      `);
    } catch (err) {
      this.logger.debug(
        `Contextual prefix cache write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // Cheap probabilistic retention sweep: the table is append-mostly and every
    // entry is a pure memo, so pruning is safe at any time.
    if (Math.random() < 0.02 && this.retentionDays > 0) {
      void withServiceContext(this.prisma, (tx) =>
        (tx as any).$executeRaw`
        DELETE FROM "ContextualPrefixCache"
        WHERE "lastUsedAt" < CURRENT_TIMESTAMP - make_interval(days => ${this.retentionDays})
      `).catch(() => undefined);
    }
  }
}
