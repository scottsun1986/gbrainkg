import { RedisService } from '../redis/redis.service';
import {
  ConnectorChange,
  EnterpriseConnector,
  FetchChangesResult,
} from './types';

export interface WebhookPayload {
  externalRevision?: ConnectorChange["externalRevision"];
  externalAcl?: ConnectorChange["externalAcl"];
  deleted?: boolean;
  externalId: string;
  title: string;
  content: string;
}

/** Per-source queue cap: an unbounded in-memory queue is an OOM vector when
 *  sync is slow or stalled — a burst of webhooks would otherwise grow the
 *  heap without limit. */
const MAX_QUEUE_PER_SOURCE = 1000;

/**
 * 通用 Webhook 连接器：外部系统推送 {externalId,title,content} 入队，
 * 下一次 sync 时作为变更拉走（至少一次投递，cursor 保证同批不重复返回）。
 */
export class WebhookConnector implements EnterpriseConnector {
  readonly kind = 'generic_webhook';

  constructor(private readonly redis: RedisService = new RedisService()) {}

  async close(): Promise<void> { await this.redis.onModuleDestroy(); }

  /** 入队一条 webhook 载荷。 */
  enqueue(sourceKey: string, payload: WebhookPayload): Promise<WebhookPayload> {
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
    if (payload.externalAcl && (!payload.externalAcl.revision || !Array.isArray(payload.externalAcl.subjects) || payload.externalAcl.subjects.length > 1000 || payload.externalAcl.subjects.some(subject => !subject?.id || !subject?.type))) throw new Error('Invalid external ACL manifest');
    const item = { externalId, title, content, ...(payload.externalRevision ? { externalRevision:payload.externalRevision } : {}), ...(payload.externalAcl ? { externalAcl:payload.externalAcl } : {}), ...(payload.deleted ? { deleted:true } : {}) };
    return this.redis.evalDurable(`
      -- append-webhook
      if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[2]) then return redis.error_reply('Webhook queue capacity exhausted') end
      local sequence = redis.call('INCR', KEYS[2])
      local item = cjson.decode(ARGV[1])
      item.sequence = sequence
      redis.call('RPUSH', KEYS[1], cjson.encode(item))
      return sequence
    `, [`webhook:${key}:pending`, `webhook:${key}:sequence`], [JSON.stringify(item), String(MAX_QUEUE_PER_SOURCE)]).then(() => item);
  }

  async queueSize(sourceKey: string): Promise<number> {
    return this.redis.evalDurable("return redis.call('LLEN', KEYS[1])", [`webhook:${sourceKey}:pending`]);
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
    // Cursor is persisted only after every change is queued durably. A failed
    // batch keeps its payloads; the next fetch retries the same sequence range.
    const raw: string[] = await this.redis.evalDurable(`
      -- fetch-webhook
      local checkpoint = tonumber(ARGV[1]) or 0
      while true do
        local head = redis.call('LINDEX', KEYS[1], 0)
        if not head or cjson.decode(head).sequence > checkpoint then break end
        redis.call('LPOP', KEYS[1])
      end
      return redis.call('LRANGE', KEYS[1], 0, 999)
    `, [`webhook:${key}:pending`], [cursor || '0']);
    const items = raw.map(value => JSON.parse(value) as WebhookPayload & { sequence: number });
    const changes: ConnectorChange[] = items.map(item => ({
      externalId: item.externalId, title: item.title, content: item.content,
      externalRevision: item.externalRevision, externalAcl: item.externalAcl,
      deleted: item.deleted, metadata: { via: 'generic_webhook' },
    }));
    return { changes, nextCursor: items.length ? String(items[items.length - 1].sequence) : cursor };

  }
}

/** Redis DB follows instance isolation; API processes share durable queue state. */
export const webhookConnector = new WebhookConnector();
