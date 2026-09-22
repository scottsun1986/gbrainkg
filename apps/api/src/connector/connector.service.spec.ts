import { ConnectorService } from './connector.service';
import { WebhookConnector } from './webhook-connector';

const mockPrisma = {
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
    findMany: jest.fn(),
  },
  document: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
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
    mockPrisma.connectorRun.update.mockResolvedValue({});
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
    expect(mockPrisma.connectorRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
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

    service.enqueueWebhook('src-1', {
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
