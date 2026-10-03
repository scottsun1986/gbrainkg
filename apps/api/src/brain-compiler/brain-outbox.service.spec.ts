import { BrainOutboxService } from './brain-outbox.service';
import { runWithRequestContext } from '../observability/request-context';
const mockFindMany = jest.fn();
const mockUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockUpdate = jest.fn();
const mockFindUnique = jest.fn();
const mockPrisma: any = { brainChangeEvent: { findMany: mockFindMany, updateMany: mockUpdateMany, update: mockUpdate, findUnique: mockFindUnique },
  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ count: 0 });
});

describe('durable pending outbox dispatcher', () => {
  it('dispatches permission revocations after a malformed enrichment event', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'bad', eventType: 'enrichment_request', payload: {} },
      { id: 'revoke', eventType: 'perm_revoke' },
    ]);
    const add = jest.fn().mockResolvedValue({});
    const service = new BrainOutboxService(
      { add, getJob: jest.fn().mockResolvedValue(undefined) } as any,
      { getJob: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
    );
    await service.dispatchPending();
    expect(add).toHaveBeenCalledWith('process-outbox-event', { eventId: 'revoke' }, expect.any(Object));
  });

  it('recovers a failed queue delivery with the same stable job identity', async () => {
    mockFindMany.mockResolvedValue([{ id: 'event-1', eventType: 'perm_revoke' }]);
    const add = jest.fn().mockRejectedValueOnce(new Error('redis offline')).mockResolvedValue({});
    const service = new BrainOutboxService({ add, getJob: jest.fn().mockResolvedValue(undefined) } as any, {} as any, {} as any);
    await service.dispatchPending();
    await service.dispatchPending();
    expect(add).toHaveBeenCalledTimes(2);
    for (const call of add.mock.calls) {
      expect(call[1]).toEqual({ eventId: 'event-1' });
      expect(call[2]).toMatchObject({ jobId: 'outbox-event-event-1', priority: 1 });
    }
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: ['pending', 'processing', 'failed'] }, retryCount: { lt: 10 } } }));
  });

  it.each(['active', 'delayed', 'waiting'])('does not steal a %s job', async state => {
    mockFindMany.mockResolvedValue([{ id: 'event-1', eventType: 'doc_change' }]);
    const retry = jest.fn();
    const add = jest.fn();
    const service = new BrainOutboxService({ add, getJob: async () => ({ getState: async () => state, retry }) } as any, {} as any, {} as any);
    await service.dispatchPending();
    expect(retry).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['failed', 'completed'])('retries terminal %s jobs when DB event is unfinished', async state => {
    mockFindMany.mockResolvedValue([{ id: 'event-1', eventType: 'doc_change' }]);
    const retry = jest.fn();
    const service = new BrainOutboxService({ getJob: async () => ({ getState: async () => state, retry }) } as any, {} as any, {} as any);
    await service.dispatchPending();
    expect(retry).toHaveBeenCalledWith(state);
  });

  it('dispatches enrichment requests to the enrichment queue with stable idempotency', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'event-enrich-1', eventType: 'enrichment_request', resourceId: 'doc-1',
      payload: { kbId: 'kb-1', version: 7 },
    }]);
    const compilerAdd = jest.fn();
    const enrichmentAdd = jest.fn().mockResolvedValue({});
    const service = new BrainOutboxService(
      { add: compilerAdd, getJob: jest.fn().mockResolvedValue(undefined) } as any,
      { add: enrichmentAdd, getJob: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
    );
    await service.dispatchPending();
    expect(compilerAdd).not.toHaveBeenCalled();
    expect(enrichmentAdd).toHaveBeenCalledWith(
      'enrich-from-outbox',
      { documentId: 'doc-1', kbId: 'kb-1', expectedVersion: 7, outboxEventId: 'event-enrich-1' },
      expect.objectContaining({ jobId: 'enrichment-outbox-event-enrich-1' }),
    );
  });

  it('leaves overflow enrichment events in the durable outbox', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'event-overflow', eventType: 'enrichment_request', resourceId: 'doc-1',
      payload: { kbId: 'kb-1', version: 1 },
    }]);
    const add = jest.fn();
    const core = { add, getJob: jest.fn().mockResolvedValue(undefined),
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 500, delayed: 0 }) };
    const service = new BrainOutboxService({ getJobCounts: jest.fn() } as any, core as any,
      { getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, delayed: 0 }) } as any);
    await service.dispatchPending();
    expect(add).not.toHaveBeenCalled();
  });

  it('routes auxiliary work to its own queue', async () => {
    mockFindMany.mockResolvedValue([{
      id: 'event-aux', eventType: 'aux_enrichment_request', resourceId: 'doc-1',
      payload: { kbId: 'kb-1', version: 1 },
    }]);
    const add = jest.fn();
    const auxiliary = { add, getJob: jest.fn().mockResolvedValue(undefined) };
    const service = new BrainOutboxService({} as any, {} as any, auxiliary as any);
    await service.dispatchPending();
    expect(add).toHaveBeenCalledWith('augment-document', expect.objectContaining({ documentId: 'doc-1' }),
      expect.objectContaining({ jobId: 'aux-outbox-event-aux' }));
  });

  it('dead-letters retry-exhausted events instead of silently dropping them', async () => {
    mockFindMany.mockResolvedValue([]);
    mockUpdateMany.mockResolvedValue({ count: 3 });
    const service = new BrainOutboxService({} as any, {} as any, {} as any);
    await service.dispatchPending();
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { status: { in: ['pending', 'failed'] }, retryCount: { gte: 10 } },
      data: { status: 'dead' },
    });
    // the exhausted events are no longer dispatch candidates
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ['pending', 'processing', 'failed'] }, retryCount: { lt: 10 } },
    }));
  });

  it('keeps dead-lettering idempotent when nothing is exhausted', async () => {
    mockFindMany.mockResolvedValue([]);
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const service = new BrainOutboxService({} as any, {} as any, {} as any);
    await expect(service.dispatchPending()).resolves.toBeUndefined();
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe('outbox dead-letter replay', () => {
  it('resets a dead event to pending with a fresh retry budget', async () => {
    mockFindUnique.mockResolvedValue({ id: 'event-1', eventType: 'perm_revoke', status: 'dead', retryCount: 10 });
    mockUpdate.mockResolvedValue({ id: 'event-1', eventType: 'perm_revoke', status: 'pending', retryCount: 0 });
    const service = new BrainOutboxService({} as any, {} as any, {} as any);
    const replayed = await service.replayDeadEvent('event-1');
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: { status: 'pending', retryCount: 0 },
    });
    expect(replayed).toMatchObject({ id: 'event-1', status: 'pending' });
  });

  it('refuses to replay an event that is not dead-lettered', async () => {
    mockFindUnique.mockResolvedValue({ id: 'event-2', status: 'failed', retryCount: 3 });
    const service = new BrainOutboxService({} as any, {} as any, {} as any);
    await expect(service.replayDeadEvent('event-2')).resolves.toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns null for an unknown event', async () => {
    mockFindUnique.mockResolvedValue(null);
    const service = new BrainOutboxService({} as any, {} as any, {} as any);
    await expect(service.replayDeadEvent('missing')).resolves.toBeNull();
  });
});

describe('outbox dispatch kick from HTTP handlers', () => {
  it('dispatches from a request context without identity-promotion failure', async () => {
    mockFindMany.mockResolvedValue([{ id: 'event-1', eventType: 'perm_revoke' }]);
    const add = jest.fn().mockResolvedValue({});
    const service = new BrainOutboxService({ add, getJob: jest.fn().mockResolvedValue(undefined) } as any, {} as any, {} as any);
    // Regression: admin mutation endpoints used to await dispatchPending inside
    // the request context, which runAsService rejects with
    // "Cannot promote request identity to service" (HTTP 500).
    await runWithRequestContext({ requestId: 'kick-regression', userId: 'admin' } as any, async () => {
      expect(() => service.kickDispatch()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(add).toHaveBeenCalledWith('process-outbox-event', { eventId: 'event-1' }, expect.any(Object));
    });
  });
});
