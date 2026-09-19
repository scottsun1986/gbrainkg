import { IngestionProcessor } from './ingestion.processor';

describe('IngestionProcessor version fencing', () => {
  it('marks only the failed document version after the final attempt', async () => {
    const service = {
      processDocument: jest.fn().mockRejectedValue(new Error('parse failed')),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new IngestionProcessor(service as any);
    const job = {
      data: { documentId: 'doc-1', expectedVersion: 7 },
      opts: { attempts: 3 },
      attemptsMade: 2,
    } as any;

    await expect(processor.process(job)).rejects.toThrow('parse failed');
    expect(service.markFailed).toHaveBeenCalledWith('doc-1', 'parse failed', 7);
  });

  it('does not mark an intermediate retry as terminally failed', async () => {
    const service = {
      processDocument: jest.fn().mockRejectedValue(new Error('temporary')),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new IngestionProcessor(service as any);
    const job = {
      data: { documentId: 'doc-1', expectedVersion: 8 },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as any;

    await expect(processor.process(job)).rejects.toThrow('temporary');
    expect(service.markFailed).not.toHaveBeenCalled();
  });
});
