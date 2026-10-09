
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
import { ConnectorService, assessConnectorFreshness } from './connector.service';
import { WebhookConnector } from './webhook-connector';

const mockPrisma: any = {
  connectorSource: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  connectorRun: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  document: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },

  $executeRaw: jest.fn().mockResolvedValue(0),
  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};

jest.mock('../prisma', () => ({
  getPrismaClient: () => mockPrisma,
}));

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => undefined),
}));

const ingestionService = {
  enqueue: jest.fn(),
};

const SOURCE = {
  id: 'src-1',
  kbId: 'kb-1',
  kind: 'git',
  name: 'handbook',
  config: { repoPath: 'repo' },
  cursor: 'commit-a',
  status: 'active',
};

describe('ConnectorService.sync', () => {
  let service: ConnectorService;
  let gitFetch: jest.Mock;
  let webhook: WebhookConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    webhook = new WebhookConnector();
    service = new ConnectorService(ingestionService as any, webhook);
    gitFetch = jest.fn();
    // 注入 mock git 连接器
    (service as any).connectors.set('git', {
      kind: 'git',
      testConnection: jest.fn(),
      fetchChanges: gitFetch,
    });
    mockPrisma.connectorSource.findUnique.mockResolvedValue({ ...SOURCE });
    mockPrisma.connectorRun.create.mockResolvedValue({ id: 'run-1' });
    mockPrisma.connectorRun.findFirst.mockResolvedValue(null);
    mockPrisma.connectorRun.update.mockResolvedValue({});
    mockPrisma.connectorRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.connectorSource.update.mockResolvedValue({});
    mockPrisma.document.findFirst.mockResolvedValue(null);
    mockPrisma.document.create.mockResolvedValue({ id: 'doc-new' });
    mockPrisma.document.update.mockResolvedValue({});
    mockPrisma.document.updateMany.mockResolvedValue({ count: 0 });
    ingestionService.enqueue.mockResolvedValue(undefined);
  });

  it('creates a ConnectorRun, ingests via IngestionService, and advances cursor', async () => {
    gitFetch.mockResolvedValue({
      changes: [
        {
          externalId: 'README.md',
          title: 'README.md',
          content: '# hello',
        },
      ],
      nextCursor: 'commit-b',
    });

    const summary = await service.sync('src-1');

    expect(mockPrisma.connectorRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceId: 'src-1', status: 'running' }),
      }),
    );
    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kbId: 'kb-1',
          sourceType: 'git',
          sourceExternalId: 'README.md',
          status: 'parsing',
        }),
      }),
    );
    expect(ingestionService.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      'connector-sync',
      1,
      3,
    );
    expect(mockPrisma.connectorSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'src-1' },
        data: expect.objectContaining({ cursor: 'commit-b' }),
      }),
    );
    expect(summary).toMatchObject({
      status: 'success',
      fetched: 1,
      ingested: 1,
      failed: 0,
    });
    expect(gitFetch).toHaveBeenCalledWith(SOURCE.config, 'commit-a');
  });

  it('is idempotent: unchanged contentHash is skipped and cursor still advances', async () => {
    const content = 'same content';
    gitFetch.mockResolvedValue({
      changes: [
        {
          externalId: 'README.md',
          title: 'README.md',
          content,
          contentHash: 'hash-1',
        },
      ],
      nextCursor: 'commit-b',
    });
    mockPrisma.document.findFirst.mockResolvedValue({
      id: 'doc-1',
      contentHash: 'hash-1',
      rawFileOid: '/tmp/x',
      version: 3,
    });

    const summary = await service.sync('src-1');

    expect(ingestionService.enqueue).not.toHaveBeenCalled();
    expect(mockPrisma.document.create).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ ingested: 0, skipped: 1, fetched: 1 });

    // 再次同步同一 cursor/同一内容 → 仍然 skipped（cursor 幂等）
    gitFetch.mockResolvedValue({
      changes: [
        {
          externalId: 'README.md',
          title: 'README.md',
          content,
          contentHash: 'hash-1',
        },
      ],
      nextCursor: 'commit-b',
    });
    const again = await service.sync('src-1');
    expect(again).toMatchObject({ ingested: 0, skipped: 1 });
  });

  it('updates existing document (version bump) when contentHash changes', async () => {
    gitFetch.mockResolvedValue({
      changes: [
        {
          externalId: 'README.md',
          title: 'README v2',
          content: 'changed',
          contentHash: 'hash-2',
        },
      ],
      nextCursor: 'commit-c',
    });
    mockPrisma.document.findFirst.mockResolvedValue({
      id: 'doc-1',
      contentHash: 'hash-1',
      rawFileOid: '/tmp/old.txt',
      version: 3,
    });

    const summary = await service.sync('src-1');

    expect(mockPrisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-1' },
        data: expect.objectContaining({ version: 4, contentHash: 'hash-2' }),
      }),
    );
    expect(ingestionService.enqueue).toHaveBeenCalledWith(
      'doc-1',
      'connector-sync',
      4,
      3,
    );
    expect(summary.ingested).toBe(1);
    expect(mockPrisma.document.create).not.toHaveBeenCalled();
  });

  it('records run failure when the connector throws, without advancing cursor', async () => {
    gitFetch.mockRejectedValue(new Error('git exploded'));
    const summary = await service.sync('src-1');
    expect(summary.status).toBe('failed');
    expect(summary.error).toMatch(/git exploded/);
    expect(mockPrisma.connectorRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'run-1', status: 'running' }),
        data: expect.objectContaining({
          status: 'failed',
          error: expect.stringMatching(/git exploded/),
        }),
      }),
    );
    // cursor 不前进
    const updateArgs = mockPrisma.connectorSource.update.mock.calls[0][0];
    expect(updateArgs.data.cursor).toBeUndefined();
  });

  it('retains the cursor when any document fails to enqueue', async () => {
    gitFetch.mockResolvedValue({ changes: [{ externalId: 'x', content: 'hello' }], nextCursor: 'commit-b' });
    ingestionService.enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
    const result = await service.sync('src-1');
    expect(result.failed).toBe(1);
    expect(mockPrisma.connectorSource.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ cursor: 'commit-a' }),
    }));
  });

  it('requeues unchanged content after a failed enqueue', async () => {
    gitFetch.mockResolvedValue({ changes: [{ externalId: 'x', contentHash: 'hash-1' }], nextCursor: 'commit-b' });
    mockPrisma.document.findFirst.mockResolvedValueOnce({ id: 'doc-1', contentHash: 'hash-1', status: 'failed', version: 2 });
    expect((await service.sync('src-1')).ingested).toBe(1);
    expect(ingestionService.enqueue).toHaveBeenCalledWith('doc-1', 'connector-sync', 2, 3);
  });

  it('rejects overlapping triggers before the first database read resolves', async () => {
    let resolveSource!: (value: any) => void;
    mockPrisma.connectorSource.findUnique.mockReturnValueOnce(new Promise(resolve => { resolveSource = resolve; }));
    gitFetch.mockResolvedValue({ changes: [] });
    const first = service.sync('src-1');
    await expect(service.sync('src-1')).rejects.toThrow('already running');
    resolveSource(SOURCE);
    await first;
  });

  it('reclaims an expired-lease running run instead of colliding forever (F01)', async () => {
    mockPrisma.connectorRun.findFirst.mockResolvedValueOnce({
      id: 'run-stale',
      ownerId: 'dead-process',
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    gitFetch.mockResolvedValue({ changes: [], nextCursor: 'commit-b' });

    const summary = await service.sync('src-1');

    expect(summary.status).toBe('success');
    // The stale run is CAS-failed before the new run claims the source.
    expect(mockPrisma.connectorRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'run-stale', status: 'running', ownerId: 'dead-process' }),
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
    const created = mockPrisma.connectorRun.create.mock.calls[0][0].data;
    expect(created.status).toBe('running');
    expect(created.ownerId).toEqual(expect.any(String));
    expect(created.leaseExpiresAt).toBeInstanceOf(Date);
    expect(created.heartbeatAt).toBeInstanceOf(Date);
  });

  it('rejects a second sync while the current lease is still valid (F01)', async () => {
    mockPrisma.connectorRun.findFirst.mockResolvedValueOnce({
      id: 'run-live',
      ownerId: 'live-process',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.sync('src-1')).rejects.toThrow('already has a running sync');
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it('does not claim a run when the reclaim CAS loses a race to a live owner (F01)', async () => {
    mockPrisma.connectorRun.findFirst
      .mockResolvedValueOnce({ id: 'run-stale', ownerId: 'dead-process', leaseExpiresAt: new Date(Date.now() - 60_000) })
      .mockResolvedValueOnce({ id: 'run-stale', leaseExpiresAt: new Date(Date.now() + 60_000) });
    mockPrisma.connectorRun.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.sync('src-1')).rejects.toThrow('already has a running sync');
    expect(mockPrisma.connectorRun.create).not.toHaveBeenCalled();
  });

  it('never advances the cursor when the terminal CAS loses ownership (F01)', async () => {
    gitFetch.mockResolvedValue({ changes: [{ externalId: 'x', content: 'hello' }], nextCursor: 'commit-b' });
    mockPrisma.connectorRun.updateMany.mockResolvedValue({ count: 0 });
    const summary = await service.sync('src-1');
    expect(summary.status).toBe('failed');
    expect(summary.error).toMatch(/lease lost/);
    expect(mockPrisma.connectorSource.update).not.toHaveBeenCalled();
  });

  it('heartbeat marks ownership lost when its CAS no longer matches', async () => {
    mockPrisma.connectorRun.updateMany.mockResolvedValueOnce({ count: 0 });
    await (service as any).renewLease('run-1');
    expect((service as any).lostOwnership.has('run-1')).toBe(true);
  });

  it('releases the local guard when creating a run fails', async () => {
    mockPrisma.connectorRun.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.sync('src-1')).rejects.toThrow('database unavailable');
    gitFetch.mockResolvedValue({ changes: [] });
    expect((await service.sync('src-1')).status).toBe('success');
  });

  it('maps feishu kind to sourceType feishu', async () => {
    (service as any).connectors.set('feishu_drive', {
      kind: 'feishu_drive',
      testConnection: jest.fn(),
      fetchChanges: jest.fn(async () => ({
        changes: [
          { externalId: 'tok-1', title: 'Doc', content: 'body' },
        ],
        nextCursor: 'tok-1',
      })),
    });
    mockPrisma.connectorSource.findUnique.mockResolvedValue({
      ...SOURCE,
      kind: 'feishu_drive',
      config: { appId: 'a', appSecret: 'b' },
      cursor: null,
    });

    await service.sync('src-1');

    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceType: 'feishu' }),
      }),
    );
  });

  it('webhook payloads enqueue then sync consumes them', async () => {
    (service as any).connectors.set('generic_webhook', webhook);
    mockPrisma.connectorSource.findUnique.mockResolvedValue({
      ...SOURCE,
      kind: 'generic_webhook',
      config: { sourceKey: 'src-1' },
      cursor: null,
    });

    await service.enqueueWebhook('src-1', {
      externalId: 'ext-1',
      title: 'T',
      content: 'C',
    });
    const summary = await service.sync('src-1');
    expect(summary).toMatchObject({ fetched: 1, ingested: 1 });
    expect(mockPrisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceExternalId: 'ext-1' }),
      }),
    );
  });

  it('rejects unknown kinds', async () => {
    mockPrisma.connectorSource.findUnique.mockResolvedValue({
      ...SOURCE,
      kind: 's3',
    });
    await expect(service.sync('src-1')).rejects.toThrow(/unsupported connector kind/);
  });
});

describe('ConnectorService freshness (stage 4 visibility)', () => {
  it('flags overdue, failed and never-synced sources without flagging fresh ones', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(assessConnectorFreshness({ lastSyncAt: new Date('2026-10-09T11:00:00Z') }, now))
      .toMatchObject({ stale: false, state: 'fresh' });
    expect(assessConnectorFreshness({ lastSyncAt: new Date('2026-10-07T00:00:00Z') }, now))
      .toMatchObject({ stale: true, state: 'overdue' });
    expect(assessConnectorFreshness({ lastSyncAt: new Date('2026-10-07T00:00:00Z'), lastError: 'boom' }, now))
      .toMatchObject({ stale: true, state: 'last_run_failed' });
    // Never synced: only overdue once a full interval has passed since creation.
    expect(assessConnectorFreshness({ lastSyncAt: null, createdAt: new Date('2026-10-08T00:00:00Z') }, now))
      .toMatchObject({ stale: true, state: 'never_synced' });
    expect(assessConnectorFreshness({ lastSyncAt: null, createdAt: new Date('2026-10-09T11:00:00Z') }, now))
      .toMatchObject({ stale: false, state: 'fresh' });
    // Per-source override wins over the global threshold.
    expect(assessConnectorFreshness({ lastSyncAt: new Date('2026-10-07T00:00:00Z'), config: { staleAfterHours: 100 } }, now))
      .toMatchObject({ stale: false, staleAfterHours: 100 });
  });

  it('returns freshness alongside every listed source', async () => {
    const service = new ConnectorService(ingestionService as any, new WebhookConnector());
    mockPrisma.connectorSource.findMany.mockResolvedValueOnce([
      { id: 'src-fresh', lastSyncAt: new Date(), lastError: null, status: 'active', config: {} },
      { id: 'src-stale', lastSyncAt: new Date(Date.now() - 3 * 86_400_000), lastError: null, status: 'active', config: {} },
    ]);
    const sources = await service.listSources('kb-1');
    expect(sources[0].freshness.stale).toBe(false);
    expect(sources[1].freshness).toMatchObject({ stale: true, state: 'overdue' });
  });
});

describe('ConnectorService source identity and unchanged-content permissions', () => {
  const saved = process.env.CORE_EXTERNAL_ACL_REQUIRED;
  beforeEach(() => {
    jest.clearAllMocks();process.env.CORE_EXTERNAL_ACL_REQUIRED='1';
    mockPrisma.documentAcl = { deleteMany:jest.fn(),createMany:jest.fn() };
    mockPrisma.brainChangeEvent = { create:jest.fn() };
    mockPrisma.document.findFirst.mockResolvedValue({ id:'existing-doc',status:'published',contentHash:'same-hash' });
  });
  afterEach(() => { if (saved === undefined) delete process.env.CORE_EXTERNAL_ACL_REQUIRED; else process.env.CORE_EXTERNAL_ACL_REQUIRED=saved; });
  it('updates ACL before skipping unchanged text and confines external identity to its connector', async () => {
    const service = new ConnectorService(ingestionService as any,new WebhookConnector());
    await (service as any).ingestChange({ ...SOURCE,config:{ aclMapping:{ mode:'inherit' } } },{ externalId:'shared-external-id',title:'doc',content:'body',contentHash:'same-hash',externalAcl:{ revision:'r2',verified:false,subjects:[] } });
    expect(mockPrisma.document.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where:expect.objectContaining({ sourceConnectorId:'src-1',sourceExternalId:'shared-external-id' }) }));
    expect(mockPrisma.document.update).toHaveBeenCalledWith(expect.objectContaining({ data:expect.objectContaining({ aclMode:'restricted' }) }));
    expect(mockPrisma.documentAcl.deleteMany).toHaveBeenCalled();
    expect(ingestionService.enqueue).not.toHaveBeenCalled();
  });
});
