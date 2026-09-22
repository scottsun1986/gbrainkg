import { WebhookConnector } from './webhook-connector';

describe('WebhookConnector', () => {
  it('enqueues {externalId,title,content} and drains on fetchChanges', async () => {
    const connector = new WebhookConnector();
    connector.enqueue('src-1', {
      externalId: 'ext-1',
      title: 'Doc 1',
      content: 'hello',
    });
    connector.enqueue('src-1', {
      externalId: 'ext-2',
      title: 'Doc 2',
      content: 'world',
    });
    expect(connector.queueSize('src-1')).toBe(2);

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
    connector.enqueue('src-a', {
      externalId: 'a1',
      title: 'A',
      content: 'ca',
    });
    connector.enqueue('src-b', {
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
