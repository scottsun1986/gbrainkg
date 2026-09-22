import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPrismaClient } from '../prisma';
import { IngestionService } from '../ingestion/ingestion.service';
import { GitConnector } from './git-connector';
import { FeishuConnector } from './feishu-connector';
import { WebhookConnector, webhookConnector } from './webhook-connector';
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

@Injectable()
export class ConnectorService {
  private readonly logger = new Logger(ConnectorService.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || '/tmp/llmwiki/uploads';
  private readonly connectors: Map<string, EnterpriseConnector>;

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

  getConnector(kind: string): EnterpriseConnector {
    const connector = this.connectors.get(kind);
    if (!connector) {
      throw new NotFoundException(`unsupported connector kind: ${kind}`);
    }
    return connector;
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
    return this.prisma.connectorSource.findMany({
      where: { kbId, status: { not: 'deleted' } },
      orderBy: { createdAt: 'desc' },
    });
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
    await this.prisma.connectorSource.delete({ where: { id: sourceId } });
    return { id: sourceId, deleted: true };
  }

  /** Webhook 入队：{externalId,title,content} 待下次 sync 消化。 */
  enqueueWebhook(sourceId: string, payload: { externalId: string; title: string; content: string }) {
    return this.webhook.enqueue(sourceId, payload);
  }

  /**
   * 同步编排：建 ConnectorRun → 拉变更 → 复用 IngestionService 创建文档
   * （sourceType feishu/git，sourceExternalId）→ 写进度与 cursor。
   */
  async sync(sourceId: string): Promise<SyncRunSummary> {
    const source = await this.getSource(sourceId);
    const connector = this.getConnector(source.kind);
    const run = await this.prisma.connectorRun.create({
      data: {
        id: randomUUID(),
        sourceId,
        status: 'running',
        startedAt: new Date(),
      },
    });

    let fetched = 0;
    let ingested = 0;
    let failed = 0;
    let skipped = 0;
    const processed: string[] = [];

    try {
      const result = await connector.fetchChanges(
        (source.config || {}) as Record<string, unknown>,
        source.cursor ?? null,
      );
      fetched = result.changes.length;

      for (const change of result.changes) {
        try {
          const outcome = await this.ingestChange(source, change);
          if (outcome === 'ingested') ingested += 1;
          else if (outcome === 'skipped') skipped += 1;
          if (outcome !== 'failed') processed.push(change.externalId);
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `connector ${sourceId} change ${change.externalId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const status = failed > 0 ? 'failed' : 'success';
      const finishedAt = new Date();
      await this.prisma.connectorRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt,
          fetched,
          ingested,
          failed,
          detail: { processed, skipped } as never,
        },
      });
      await this.prisma.connectorSource.update({
        where: { id: sourceId },
        data: {
          cursor: result.nextCursor ?? source.cursor,
          lastSyncAt: finishedAt,
          lastError: failed > 0 ? `${failed} change(s) failed` : null,
        },
      });

      return {
        runId: run.id,
        sourceId,
        status,
        fetched,
        ingested,
        failed,
        skipped,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.connectorRun.update({
        where: { id: run.id },
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
      await this.prisma.connectorSource.update({
        where: { id: sourceId },
        data: { lastError: message, lastSyncAt: new Date() },
      });
      return {
        runId: run.id,
        sourceId,
        status: 'failed',
        fetched,
        ingested,
        failed: failed || 1,
        skipped,
        error: message,
      };
    }
  }

  /**
   * 单条变更入库：按 sourceExternalId + contentHash 幂等，
   * 文档创建后走 IngestionService.enqueue 进入既有管线。
   */
  private async ingestChange(
    source: { id: string; kbId: string; kind: string },
    change: ConnectorChange,
  ): Promise<'ingested' | 'skipped' | 'failed'> {
    if (change.deleted) {
      await this.prisma.document.updateMany({
        where: {
          kbId: source.kbId,
          sourceExternalId: change.externalId,
          lifecycleStatus: 'current',
        },
        data: { lifecycleStatus: 'repealed', effectiveTo: new Date() },
      });
      return 'skipped';
    }

    const content = String(change.content ?? '');
    const contentHash =
      change.contentHash ||
      createHash('sha256').update(content, 'utf8').digest('hex');

    const existing = await this.prisma.document.findFirst({
      where: {
        kbId: source.kbId,
        sourceExternalId: change.externalId,
        lifecycleStatus: 'current',
      },
      select: { id: true, contentHash: true, rawFileOid: true, version: true },
    });

    if (existing && existing.contentHash === contentHash) {
      return 'skipped';
    }

    const sourceType = sourceTypeForKind(source.kind);
    const title = String(change.title || change.externalId).slice(0, 200);

    if (existing && existing.rawFileOid) {
      await writeFile(existing.rawFileOid, content, 'utf8');
      const nextVersion = (existing.version || 1) + 1;
      await this.prisma.document.update({
        where: { id: existing.id },
        data: {
          title,
          contentHash,
          version: nextVersion,
          status: 'parsing',
        },
      });
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

    await this.prisma.document.create({
      data: {
        id: documentId,
        kbId: source.kbId,
        mdPath: join(documentId, 'content.md'),
        title,
        sourceType,
        rawFileOid: rawAbs,
        contentHash,
        sourceExternalId: change.externalId,
        sourceCursor: null,
        status: 'parsing',
      },
    });
    await this.ingestionService.enqueue(documentId, 'connector-sync', 1, 3);
    return 'ingested';
  }
}
