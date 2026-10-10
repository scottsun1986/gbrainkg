import { uploadRoot } from '../storage/upload-paths';
import { instanceIdentity } from '../observability/instance-identity';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { immutableVersionsEnabled } from '../ingestion/document-version-store';
import { syncExternalAcl } from './external-acl';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getPrismaClient } from '../prisma';
import { withSystemWrite } from '../db/tenant-context.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { GitConnector } from './git-connector';
import { FeishuConnector } from './feishu-connector';
import { WebhookConnector, webhookConnector, WebhookPayload } from './webhook-connector';
import {
  ConnectorChange,
  EnterpriseConnector,
  sourceTypeForKind,
} from './types';

export interface SyncRunSummary {
  runId: string;
  sourceId: string;
  status: string;
  fetched: number;
  ingested: number;
  failed: number;
  skipped: number;
  error?: string;
}

export interface ConnectorFreshness {
  lastSyncAt: string | null;
  staleAfterHours: number;
  stale: boolean;
  /** never_synced | overdue | last_run_failed | fresh */
  state: 'never_synced' | 'overdue' | 'last_run_failed' | 'fresh';
}

/**
 * Freshness assessment for the connector list (stage 4: operator visibility).
 * A source that silently stopped syncing keeps serving old knowledge, so the
 * list must say when the last successful sync is overdue instead of leaving
 * that to a manual timestamp comparison. Threshold overridable per source
 * (`config.staleAfterHours`) or globally (CONNECTOR_FRESHNESS_STALE_HOURS).
 *
 * B06: `lastSyncAt` records the last COMPLETE success only (failed runs write
 * `lastError`, not `lastSyncAt`), and a recorded failure is shown even when
 * that success is recent — a fresh-looking timestamp must never present
 * failed knowledge as up to date. A source without any successful sync is
 * `never_synced`, never `fresh`.
 */
export function assessConnectorFreshness(
  source: { lastSyncAt?: Date | string | null; lastError?: string | null; createdAt?: Date | string | null; config?: unknown },
  now: Date = new Date(),
): ConnectorFreshness {
  const fallbackHours = Math.max(1, Number(process.env.CONNECTOR_FRESHNESS_STALE_HOURS || 24));
  const configured = Number((source.config as any)?.staleAfterHours);
  const staleAfterHours = Number.isFinite(configured) && configured > 0 ? configured : fallbackHours;
  const lastSyncAt = source.lastSyncAt ? new Date(source.lastSyncAt) : null;
  if (!lastSyncAt || Number.isNaN(lastSyncAt.getTime())) {
    // Never fully synced: not "fresh" at any age — only the threshold decides
    // whether it is already overdue as well.
    const createdAt = source.createdAt ? new Date(source.createdAt) : null;
    const ageHours = createdAt && !Number.isNaN(createdAt.getTime())
      ? (now.getTime() - createdAt.getTime()) / 3_600_000
      : 0;
    return {
      lastSyncAt: null,
      staleAfterHours,
      stale: ageHours >= staleAfterHours,
      state: 'never_synced',
    };
  }
  const ageHours = (now.getTime() - lastSyncAt.getTime()) / 3_600_000;
  // Failure wins over recency: operators see the error and the age of the
  // knowledge separately (stale still measures the last full success).
  if (source.lastError) {
    return {
      lastSyncAt: lastSyncAt.toISOString(),
      staleAfterHours,
      stale: ageHours >= staleAfterHours,
      state: 'last_run_failed',
    };
  }
  if (ageHours < staleAfterHours) {
    return { lastSyncAt: lastSyncAt.toISOString(), staleAfterHours, stale: false, state: 'fresh' };
  }
  return {
    lastSyncAt: lastSyncAt.toISOString(),
    staleAfterHours,
    stale: true,
    state: 'overdue',
  };
}

/** Raised when a business write cannot confirm it still owns the run (B03). */
export class RunLeaseLostError extends Error {
  constructor(runId: string) {
    super(`connector run ${runId} lost its lease before a business write; suppressed`);
    this.name = 'RunLeaseLostError';
  }
}

@Injectable()
export class ConnectorService {
  private readonly logger = new Logger(ConnectorService.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    uploadRoot();
  private readonly connectors: Map<string, EnterpriseConnector>;
  private readonly runningSyncs = new Set<string>();
  /**
   * This process's execution identity for connector runs. One id per service
   * instance is enough: a given source has at most one local sync (runningSyncs)
   * and the lease CAS decides across processes.
   */
  private readonly ownerId = `${instanceIdentity()}:${randomUUID()}`;
  private readonly leaseMs = Math.max(30_000, Number(process.env.CONNECTOR_SYNC_LEASE_MS || 120_000));
  /** Runs whose lease heartbeat no longer matches: stop persisting work on them. */
  private readonly lostOwnership = new Set<string>();

  constructor(
    // 复用 IngestionService：创建文档后走既有解析/索引管线
    private readonly ingestionService: IngestionService,
    @Optional() private readonly webhook: WebhookConnector = webhookConnector,
  ) {
    this.connectors = new Map<string, EnterpriseConnector>([
      ['git', new GitConnector()],
      ['feishu_drive', new FeishuConnector('feishu_drive')],
      ['feishu_wiki', new FeishuConnector('feishu_wiki')],
      ['generic_webhook', this.webhook],
    ]);
  }

  async onModuleDestroy(): Promise<void> { await this.webhook.close(); }

  getConnector(kind: string): EnterpriseConnector {
    const connector = this.connectors.get(kind);
    if (!connector) {
      throw new NotFoundException(`unsupported connector kind: ${kind}`);
    }
    return connector;
  }

  /**
   * Central raw-file path resolution. rawFileOid is stored as an absolute
   * path under uploadRoot, but legacy rows may hold relative values —
   * resolve both against uploadRoot instead of assuming one convention.
   */
  private resolveRawPath(rawFileOid: string | null | undefined): string | null {
    if (!rawFileOid) return null;
    return isAbsolute(rawFileOid) ? rawFileOid : join(this.uploadRoot, rawFileOid);
  }

  async createSource(input: {
    kbId: string;
    kind: string;
    name: string;
    config?: Record<string, unknown>;
  }) {
    this.getConnector(input.kind); // 校验 kind
    return this.prisma.connectorSource.create({
      data: {
        id: randomUUID(),
        kbId: input.kbId,
        kind: input.kind,
        name: String(input.name || '').trim() || input.kind,
        config: (input.config || {}) as never,
        status: 'active',
      },
    });
  }

  async listSources(kbId: string) {
    const sources = await this.prisma.connectorSource.findMany({
      where: { kbId, status: { not: 'deleted' } },
      orderBy: { createdAt: 'desc' },
    });
    // Freshness (stage 4): the list is the operator's only view of whether a
    // source still advances; mark overdue sources instead of making every
    // caller re-derive it from timestamps.
    return sources.map((source: any) => ({
      ...source,
      freshness: assessConnectorFreshness(source),
    }));
  }

  async getSource(sourceId: string) {
    const source = await this.prisma.connectorSource.findUnique({
      where: { id: sourceId },
    });
    if (!source) throw new NotFoundException('connector source not found');
    return source;
  }

  async listRuns(sourceId: string, limit = 20) {
    return this.prisma.connectorRun.findMany({
      where: { sourceId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async deleteSource(sourceId: string) {
    await this.getSource(sourceId);
    // Soft delete: listSources filters status != 'deleted', so a hard delete
    // would make that filter dead code (and lose the sync history).
    await this.prisma.connectorSource.update({
      where: { id: sourceId },
      data: { status: 'deleted' },
    });
    return { id: sourceId, deleted: true };
  }

  /** Webhook 入队：{externalId,title,content} 待下次 sync 消化。 */
  enqueueWebhook(sourceId: string, payload: WebhookPayload) {
    return this.webhook.enqueue(sourceId, payload);
  }

  /**
   * 同步编排：建 ConnectorRun → 拉变更 → 复用 IngestionService 创建文档
   * （sourceType feishu/git，sourceExternalId）→ 写进度与 cursor。
   */
  async sync(sourceId: string): Promise<SyncRunSummary> {
    if (this.runningSyncs.has(sourceId)) {
      throw new ConflictException(`connector source ${sourceId} sync is already running`);
    }
    this.runningSyncs.add(sourceId);
    try {
      return await this.syncLocked(sourceId);
    } finally {
      this.runningSyncs.delete(sourceId);
    }
  }

  // A connector sync is a system operation the endpoint merely triggers: it
  // writes ConnectorRun records and external ACLs, whose RLS policies are
  // service-only. `withServiceContext` keeps the CALLER's user identity inside a
  // request, so it was denied here with a 42501 on ConnectorRun. The caller is
  // authorised by the endpoint before we get here; the work itself is system-owned.
  private async syncLocked(sourceId: string): Promise<SyncRunSummary> {
    const { source, run } = await withSystemWrite(this.prisma, async (tx) => {
      // Serialize the claim across API processes sharing this database.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sourceId}, 0))`;
      const source = await tx.connectorSource.findUnique({ where: { id: sourceId } });
      if (!source || source.status !== 'active') throw new NotFoundException('active connector source not found');
      this.getConnector(source.kind);
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
      const activeRun = await tx.connectorRun.findFirst({
        where: { sourceId, status: 'running' },
        select: { id: true, ownerId: true, leaseExpiresAt: true },
      });
      if (activeRun) {
        const leaseValid = activeRun.leaseExpiresAt != null
          && new Date(activeRun.leaseExpiresAt).getTime() > now.getTime();
        if (leaseValid) {
          throw new ConflictException(`connector source ${sourceId} already has a running sync (run ${activeRun.id})`);
        }
        // Crashed executor (F01): the persisted running row has an expired (or
        // absent, pre-lease) lease. Reclaim it by CAS on the recorded owner and
        // lease value so a live executor that refreshed ownership meanwhile is
        // not overwritten.
        const reclaimed = await tx.connectorRun.updateMany({
          where: {
            id: activeRun.id,
            status: 'running',
            ownerId: activeRun.ownerId ?? null,
            leaseExpiresAt: activeRun.leaseExpiresAt,
          },
          data: {
            status: 'failed',
            finishedAt: now,
            error: 'sync lease expired; reclaimed by a newer run',
            heartbeatAt: now,
          },
        });
        if (reclaimed.count === 0) {
          const stillRunning = await tx.connectorRun.findFirst({
            where: { sourceId, status: 'running' },
            select: { id: true, leaseExpiresAt: true },
          });
          const stillLeased = stillRunning?.leaseExpiresAt != null
            && new Date(stillRunning.leaseExpiresAt).getTime() > now.getTime();
          if (stillRunning && stillLeased) {
            throw new ConflictException(`connector source ${sourceId} already has a running sync (run ${stillRunning.id})`);
          }
        }
      }
      const run = await tx.connectorRun.create({
        data: {
          id: randomUUID(), sourceId, status: 'running', startedAt: now,
          ownerId: this.ownerId, leaseExpiresAt, heartbeatAt: now,
        },
      });
      return { source, run };
    });
    const connector = this.getConnector(source.kind);

    // Lease heartbeat (F01): renew while this execution owns the run. A
    // heartbeat that no longer matches a running row owned by us means another
    // process reclaimed the run; work must then stop persisting state.
    const heartbeatTimer = setInterval(
      () => { void this.renewLease(run.id); },
      Math.max(5_000, Math.floor(this.leaseMs / 3)),
    );
    heartbeatTimer.unref?.();

    let fetched = 0;
    let ingested = 0;
    let failed = 0;
    let skipped = 0;
    const processed: string[] = [];

    try {
      const result = await connector.fetchChanges(
        { ...((source.config || {}) as Record<string, unknown>), ...(source.kind === "generic_webhook" ? { sourceKey: source.id } : {}) },
        source.cursor ?? null,
      );
      fetched = result.changes.length;
      // Per-object failures (B04): a partial scan is a failed run, not a
      // silent success — the checkpoint only advances on a complete pass.
      const downloadFailures = result.failures ?? [];
      if (result.snapshotIds && (process.env.CORE_EXTERNAL_ACL_REQUIRED==='1' || process.env.CORE_AUTH_ENFORCE==='1')) {
        // Snapshot repeal is a business write: it must confirm run ownership
        // in the same transaction instead of trusting the in-memory flag
        // (B03) — a reclaimed executor must not repeal documents that a
        // newer run still reports.
        await this.withRunOwnership(run.id, tx => tx.document.updateMany({ where:{ sourceConnectorId:sourceId, lifecycleStatus:'current',sourceExternalId:{ notIn:result.snapshotIds } },data:{ lifecycleStatus:'repealed',effectiveTo:new Date() } }));
      }

      for (const change of result.changes) {
        if (this.lostOwnership.has(run.id)) {
          this.logger.warn(
            `connector ${sourceId} lost its run lease; stopping before change ${change.externalId} (a newer run owns the source)`,
          );
          break;
        }
        try {
          const outcome = await this.ingestChange(source, change, run.id);
          if (outcome === 'ingested') ingested += 1;
          else if (outcome === 'skipped') skipped += 1;
          if (outcome !== 'failed') processed.push(change.externalId);
        } catch (err) {
          if (err instanceof RunLeaseLostError) throw err;
          failed += 1;
          this.logger.warn(
            `connector ${sourceId} change ${change.externalId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // A reclaimed run must not touch the cursor or report success: the newer
      // owner continues from the retained checkpoint.
      if (this.lostOwnership.has(run.id)) {
        return {
          runId: run.id,
          sourceId,
          status: 'failed',
          fetched,
          ingested,
          failed: failed || 1,
          skipped,
          error: 'sync lease lost; reclaimed by a newer run',
        };
      }

      const failedTotal = failed + downloadFailures.length;
      const failureDetail = [
        failed > 0 ? `${failed} change(s) failed` : '',
        downloadFailures.length
          ? `${downloadFailures.length} object(s) failed to fetch: ${downloadFailures.slice(0, 5).map(item => `${item.externalId} (${item.error})`).join(', ')}${downloadFailures.length > 5 ? '…' : ''}`
          : '',
      ].filter(Boolean).join('; ') || null;
      const status = failedTotal > 0 ? 'failed' : 'success';
      const finishedAt = new Date();
      const finalized = await withSystemWrite(this.prisma, async (tx) => {
        // CAS on (id, owner, still-running): a terminal write from a stale
        // executor is a no-op instead of overwriting the newer run's state.
        const guard = await tx.connectorRun.updateMany({
          where: { id: run.id, ownerId: this.ownerId, status: 'running' },
          data: {
            status,
            finishedAt,
            fetched,
            ingested,
            failed: failedTotal,
            detail: { processed, skipped, ...(downloadFailures.length ? { downloadFailures } : {}) } as never,
          },
        });
        if (guard.count === 0) return false;
        await tx.connectorSource.update({
          where: { id: sourceId },
          data: {
            // Retain the checkpoint until every change has been durably queued
            // and every object was fetched (B04).
            cursor: failedTotal > 0 ? source.cursor : (result.nextCursor ?? source.cursor),
            // B06: lastSyncAt marks the last COMPLETE success. A failed or
            // partial run records lastError instead, so freshness never
            // interprets a failure timestamp as updated knowledge.
            ...(status === 'success' ? { lastSyncAt: finishedAt } : {}),
            lastError: failureDetail,
          },
        });
        return true;
      });

      if (!finalized) {
        return {
          runId: run.id,
          sourceId,
          status: 'failed',
          fetched,
          ingested,
          failed: failed || 1,
          skipped,
          error: 'sync lease lost; reclaimed by a newer run',
        };
      }

      return {
        runId: run.id,
        sourceId,
        status,
        fetched,
        ingested,
        failed: failedTotal,
        skipped,
        ...(failureDetail ? { error: failureDetail } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const finalized = await withSystemWrite(this.prisma, async (tx) => {
        const guard = await tx.connectorRun.updateMany({
          where: { id: run.id, ownerId: this.ownerId, status: 'running' },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            fetched,
            ingested,
            failed: failed || 1,
            error: message,
            detail: { processed, skipped } as never,
          },
        });
        if (guard.count === 0) return false;
        await tx.connectorSource.update({
          where: { id: sourceId },
          // B06: a failed attempt must not read as updated knowledge — only
          // lastError advances here; lastSyncAt keeps the last full success.
          data: { lastError: message },
        });
        if ((source.config as any)?.syncAcl === true || process.env.CORE_EXTERNAL_ACL_REQUIRED === '1' || process.env.CORE_AUTH_ENFORCE === '1') {
          const docs = await tx.document.findMany({ where:{ sourceConnectorId:sourceId }, select:{ id:true } });
          await tx.document.updateMany({ where:{ sourceConnectorId:sourceId }, data:{ aclMode:'restricted',sourceAclSyncStatus:'source_unavailable' } });
          await tx.documentAcl.deleteMany({ where:{ documentId:{ in:docs.map((d: { id:string }) => d.id) } } });
          if (docs.length) await tx.brainChangeEvent.createMany({ data:docs.map((d: { id:string }) => ({ eventType:'doc_acl_change',resourceType:'document',resourceId:d.id,status:'pending',payload:{ reason:'source_unavailable' } })) });
        }
        return true;
      });
      return {
        runId: run.id,
        sourceId,
        status: 'failed',
        fetched,
        ingested,
        failed: failed || 1,
        skipped,
        error: finalized ? message : `${message} (sync lease lost; reclaimed by a newer run)`,
      };
    } finally {
      clearInterval(heartbeatTimer);
      this.lostOwnership.delete(run.id);
    }
  }

  /**
   * Renew this execution's lease on a run. A no-match update means the run is
   * no longer owned/running (reclaimed after a missed heartbeat or finalized),
   * so later persistence from this executor must be suppressed.
   */
  private async renewLease(runId: string): Promise<void> {
    try {
      const now = new Date();
      const result: { count: number } = await withSystemWrite(this.prisma, (tx) =>
        tx.connectorRun.updateMany({
          where: { id: runId, ownerId: this.ownerId, status: 'running' },
          data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) },
        }),
      );
      if (result.count === 0) this.lostOwnership.add(runId);
    } catch (err) {
      this.logger.warn(
        `connector run ${runId} lease heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Run-ownership fence for connector business writes (B03). The lease
   * heartbeat and the terminal CAS cannot undo document/ACL writes an
   * executor already flushed after its run was reclaimed, so every business
   * write runs in one transaction that first locks the run row (FOR UPDATE)
   * and re-validates owner + status. The reclaimer's CAS update targets the
   * same row, so reclaim and business writes serialize: whichever commits
   * first wins, and a reclaimed executor fails this check instead of
   * repealing documents or writing ACLs that a newer run contradicts.
   * External HTTP and file handling stay outside this fence.
   */
  private async withRunOwnership<T>(runId: string, work: (tx: any) => Promise<T>): Promise<T> {
    return withSystemWrite(this.prisma, async (tx) => {
      const owned = await tx.$queryRaw`SELECT id FROM "ConnectorRun" WHERE id = ${runId}::uuid AND "ownerId" = ${this.ownerId} AND status = 'running' FOR UPDATE`;
      if (!owned || !(owned as any).length) throw new RunLeaseLostError(runId);
      return work(tx);
    });
  }

  /**
   * 单条变更入库：按 sourceExternalId + contentHash 幂等，
   * 文档创建后走 IngestionService.enqueue 进入既有管线。
   * 所有数据库写入经 withRunOwnership 在同一事务内校验运行所有权（B03）；
   * 文件写入与队列入队保持在事务之外。
   */
  private async ingestChange(
    source: { id: string; kbId: string; kind: string; config?: any },
    change: ConnectorChange,
    runId?: string,
  ): Promise<'ingested' | 'skipped' | 'failed'> {
    const guarded = <T>(work: (tx: any) => Promise<T>): Promise<T> =>
      runId ? this.withRunOwnership(runId, work) : withSystemWrite(this.prisma, work);

    if (change.deleted) {
      await guarded(tx => tx.document.updateMany({
        where: {
          kbId: source.kbId,
          sourceExternalId: change.externalId, sourceConnectorId: source.id,
          lifecycleStatus: 'current',
        },
        data: { lifecycleStatus: 'repealed', effectiveTo: new Date() },
      }));
      return 'skipped';
    }

    const content = String(change.content ?? '');
    const contentHash =
      change.contentHash ||
      createHash('sha256').update(content, 'utf8').digest('hex');

    const existing = await this.prisma.document.findFirst({
      where: {
        kbId: source.kbId,
        sourceExternalId: change.externalId, sourceConnectorId: source.id,
        lifecycleStatus: 'current',
      },
      select: { id: true, contentHash: true, rawFileOid: true, version: true, status: true,
        ...(immutableVersionsEnabled() ? { ingestVersion: true, pendingContentHash: true } : {}) },
    });
    const enforceSourceAcl = (source.config as any)?.syncAcl === true || !!change.externalAcl || process.env.CORE_EXTERNAL_ACL_REQUIRED === '1' || process.env.CORE_AUTH_ENFORCE === '1';
    if (existing && enforceSourceAcl) await guarded(tx => syncExternalAcl(tx, existing.id, source.config, change));

    if (change.aclOnly) return 'skipped';

    if (existing && existing.contentHash === contentHash) {
      // A previous enqueue may have failed after the document was persisted.
      if (existing.status === 'parsing' || existing.status === 'failed') {
        await this.ingestionService.enqueue(existing.id, 'connector-sync', existing.version, 3);
        return 'ingested';
      }
      return 'skipped';
    }

    const sourceType = sourceTypeForKind(source.kind);
    const title = String(change.title || change.externalId).slice(0, 200);

    const existingRawPath = this.resolveRawPath(existing?.rawFileOid);
    if (immutableVersionsEnabled() && existing && existingRawPath) {
      if (existing.pendingContentHash === contentHash) {
        await this.ingestionService.enqueue(existing.id, 'connector-sync', existing.ingestVersion || existing.version, 3);
        return 'ingested';
      }
      const rawAbs = join(this.uploadRoot, existing.id, `input.${contentHash}.txt`);
      await mkdir(join(this.uploadRoot, existing.id), { recursive: true });
      await writeFile(rawAbs, content, 'utf8');
      const updated: any = await guarded(tx => tx.document.update({ where: { id: existing.id }, data: {
        ingestVersion: { increment: 1 }, pendingRawFileOid: rawAbs, pendingTitle: title, pendingContentHash: contentHash,
      } }));
      await this.ingestionService.enqueue(existing.id, 'connector-sync', updated.ingestVersion || updated.version, 3);
      return 'ingested';
    }
    if (existing && existingRawPath) {
      const replacementPath = join(this.uploadRoot, existing.id, `input.${contentHash}.txt`);
      await mkdir(join(this.uploadRoot, existing.id), { recursive: true });
      await writeFile(replacementPath, content, 'utf8');
      const nextVersion = (existing.version || 1) + 1;
      await guarded(tx => tx.document.update({
        where: { id: existing.id },
        data: {
          title,
          contentHash,
          rawFileOid: replacementPath,
          version: nextVersion,
          status: 'parsing',
        },
      }));
      await this.ingestionService.enqueue(
        existing.id,
        'connector-sync',
        nextVersion,
        3,
      );
      return 'ingested';
    }

    const documentId = randomUUID();
    const fileName = `${createHash('sha256')
      .update(change.externalId)
      .digest('hex')
      .slice(0, 16)}.txt`;
    const rawRel = join(documentId, fileName);
    const rawAbs = join(this.uploadRoot, rawRel);
    await mkdir(join(this.uploadRoot, documentId), { recursive: true });
    await writeFile(rawAbs, content, 'utf8');

    await guarded(async tx => {
      await tx.document.create({
        data: {
          id: documentId,
          kbId: source.kbId,
          mdPath: join(documentId, 'content.md'),
          title,
          sourceType,
          rawFileOid: rawAbs,
          contentHash,
          sourceExternalId: change.externalId, sourceConnectorId: source.id,
          sourceCursor: null,
          status: 'parsing',
          ...(enforceSourceAcl ? { aclMode: 'restricted' } : {}),
        },
      });
      if (enforceSourceAcl) await syncExternalAcl(tx, documentId, source.config, change);
    });
    await this.ingestionService.enqueue(documentId, 'connector-sync', 1, 3);
    return 'ingested';
  }
}
