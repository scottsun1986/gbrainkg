import {
  ConnectorChange,
  EnterpriseConnector,
  FetchChangesResult,
} from './types';

export interface WebhookPayload {
  externalId: string;
  title: string;
  content: string;
}

/**
 * 通用 Webhook 连接器：外部系统推送 {externalId,title,content} 入队，
 * 下一次 sync 时作为变更拉走（至少一次投递，cursor 保证同批不重复返回）。
 */
export class WebhookConnector implements EnterpriseConnector {
  readonly kind = 'generic_webhook';

  private readonly pending = new Map<string, WebhookPayload[]>();

  /** 入队一条 webhook 载荷。 */
  enqueue(sourceKey: string, payload: WebhookPayload): WebhookPayload {
    const key = String(sourceKey || '').trim();
    if (!key) throw new Error('webhook sourceKey is required');
    const externalId = String(payload?.externalId || '').trim();
    const title = String(payload?.title || '').trim();
    const content = String(payload?.content ?? '');
    if (!externalId) throw new Error('webhook payload requires externalId');
    if (!title) throw new Error('webhook payload requires title');
    if (typeof payload?.content !== 'string') {
      throw new Error('webhook payload requires string content');
    }
    const item = { externalId, title, content };
    const list = this.pending.get(key) || [];
    list.push(item);
    this.pending.set(key, list);
    return item;
  }

  queueSize(sourceKey: string): number {
    return (this.pending.get(String(sourceKey || '')) || []).length;
  }

  async testConnection(_config: Record<string, unknown>): Promise<void> {
    // Webhook 为纯入站队列，无需出网校验。
    return;
  }

  async fetchChanges(
    config: Record<string, unknown>,
    cursor: string | null,
  ): Promise<FetchChangesResult> {
    const key = String(config.sourceKey ?? config.sourceId ?? '').trim();
    if (!key) throw new Error('webhook config requires sourceKey');
    const items = this.pending.get(key) || [];
    if (!items.length) {
      return { changes: [], nextCursor: cursor };
    }
    // 一次性出队 → 同一 cursor 再拉不会重复得到这批（幂等）
    this.pending.set(key, []);
    const changes: ConnectorChange[] = items.map((item) => ({
      externalId: item.externalId,
      title: item.title,
      content: item.content,
      metadata: { via: 'generic_webhook' },
    }));
    const batchId = `${Date.now()}-${changes.length}`;
    return { changes, nextCursor: batchId };
  }
}

/** 进程内共享实例：webhook 入队与 sync 出队必须命中同一队列。 */
export const webhookConnector = new WebhookConnector();
