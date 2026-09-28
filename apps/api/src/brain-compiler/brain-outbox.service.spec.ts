import { BrainOutboxService } from './brain-outbox.service';
const mockFindMany = jest.fn();
const mockPrisma = { brainChangeEvent: { findMany: mockFindMany },
  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};
jest.mock('../prisma', () => ({ getPrismaClient: () => mockPrisma }));

describe('durable pending outbox dispatcher', () => {
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
});
