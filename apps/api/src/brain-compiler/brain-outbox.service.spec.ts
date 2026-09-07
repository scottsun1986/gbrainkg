import { BrainOutboxService } from './brain-outbox.service';
const mockFindMany = jest.fn();
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => ({ brainChangeEvent: { findMany: mockFindMany } })) }));

describe('durable pending outbox dispatcher', () => {
  it('recovers a failed queue delivery with the same stable job identity', async () => {
    mockFindMany.mockResolvedValue([{ id: 'event-1', eventType: 'perm_revoke' }]);
    const add = jest.fn().mockRejectedValueOnce(new Error('redis offline')).mockResolvedValue({});
    const service = new BrainOutboxService({ add, getJob: jest.fn().mockResolvedValue(undefined) } as any);
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
    const service = new BrainOutboxService({ add, getJob: async () => ({ getState: async () => state, retry }) } as any);
    await service.dispatchPending();
    expect(retry).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['failed', 'completed'])('retries terminal %s jobs when DB event is unfinished', async state => {
    mockFindMany.mockResolvedValue([{ id: 'event-1', eventType: 'doc_change' }]);
    const retry = jest.fn();
    const service = new BrainOutboxService({ getJob: async () => ({ getState: async () => state, retry }) } as any);
    await service.dispatchPending();
    expect(retry).toHaveBeenCalledWith(state);
  });
});
