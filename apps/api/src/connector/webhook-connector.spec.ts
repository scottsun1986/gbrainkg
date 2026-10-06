
jest.mock('../redis/redis.service', () => ({
  RedisService: class {
    private queues = new Map<string, any[]>();
    private sequence = 0;
    async evalDurable(script: string, keys: string[], args: string[] = []) {
      let rows = this.queues.get(keys[0]) || [];
      if (script.includes('append-webhook')) {
        if (rows.length >= Number(args[1])) throw new Error('Webhook queue capacity exhausted');
        rows.push({ ...JSON.parse(args[0]), sequence: ++this.sequence });
        this.queues.set(keys[0], rows);
        return this.sequence;
      }
      if (script.includes('fetch-webhook')) {
        rows = rows.filter(row => row.sequence > Number(args[0]));
        this.queues.set(keys[0], rows);
        return rows.map(row => JSON.stringify(row));
      }
      return rows.length;
    }
    async onModuleDestroy() {}
  },
}));
import { WebhookConnector } from './webhook-connector';

describe('WebhookConnector', () => {
  it('enqueues {externalId,title,content} and drains on fetchChanges', async () => {
    const connector = new WebhookConnector();
    await connector.enqueue('src-1', {
      externalId: 'ext-1',
      title: 'Doc 1',
      content: 'hello',
    });
    await connector.enqueue('src-1', {
      externalId: 'ext-2',
      title: 'Doc 2',
      content: 'world',
    });
    expect(await connector.queueSize('src-1')).toBe(2);

    const result = await connector.fetchChanges({ sourceKey: 'src-1' }, null);
    expect(result.changes).toEqual([
      expect.objectContaining({
        externalId: 'ext-1',
        title: 'Doc 1',
        content: 'hello',
      }),
      expect.objectContaining({
        externalId: 'ext-2',
        title: 'Doc 2',
        content: 'world',
      }),
    ]);
    expect(result.nextCursor).toBeTruthy();

    // 幂等：同一 cursor 再拉为空
    const again = await connector.fetchChanges(
      { sourceKey: 'src-1' },
      result.nextCursor,
    );
    expect(again.changes).toEqual([]);
  });

  it('retains fetched payloads until a committed cursor acknowledges them', async () => {
    const connector = new WebhookConnector();
    await connector.enqueue('src-retry', { externalId: 'one', title: 'one', content: 'body' });
    const first = await connector.fetchChanges({ sourceKey: 'src-retry' }, null);
    const retried = await connector.fetchChanges({ sourceKey: 'src-retry' }, null);
    expect(retried.changes).toEqual(first.changes);
    const committed = await connector.fetchChanges({ sourceKey: 'src-retry' }, first.nextCursor);
    expect(committed.changes).toEqual([]);
  });

  it('rejects malformed payloads', () => {
    const connector = new WebhookConnector();
    expect(() =>
      connector.enqueue('src-1', { externalId: '', title: 'x', content: 'y' }),
    ).toThrow(/externalId/);
    expect(() =>
      connector.enqueue('src-1', { externalId: 'e', title: '', content: 'y' }),
    ).toThrow(/title/);
    expect(() =>
      connector.enqueue('src-1', {
        externalId: 'e',
        title: 't',
        content: undefined as any,
      }),
    ).toThrow(/content/);
    expect(() =>
      connector.enqueue('', { externalId: 'e', title: 't', content: 'c' }),
    ).toThrow(/sourceKey/);
  });

  it('isolates queues per sourceKey', async () => {
    const connector = new WebhookConnector();
    await connector.enqueue('src-a', {
      externalId: 'a1',
      title: 'A',
      content: 'ca',
    });
    await connector.enqueue('src-b', {
      externalId: 'b1',
      title: 'B',
      content: 'cb',
    });
    const a = await connector.fetchChanges({ sourceKey: 'src-a' }, null);
    expect(a.changes.map((c) => c.externalId)).toEqual(['a1']);
    const b = await connector.fetchChanges({ sourceKey: 'src-b' }, null);
    expect(b.changes.map((c) => c.externalId)).toEqual(['b1']);
  });
});
