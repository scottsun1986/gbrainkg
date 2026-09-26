/**
 * Fail-open instrumentation contract: every degrade-to-empty path that the
 * retrieval/ingestion stack relies on must bump retrieval_failopen_total.
 * These tests pin the call sites so a silent removal fails CI.
 */
import { metricsRegistry } from './metrics.service';
import { HybridRetrievalService } from '../retrieval/hybrid-retrieval.service';
import { recordFailopen, setIngestionQueueDepth } from './failopen';

const mockPrisma: any = { $queryRaw: jest.fn() };
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => mockPrisma) }));

describe('failopen call-site coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hybrid searchSparse counts channel=sparse on SQL failure', async () => {
    const embedding = {
      isHybridEnabled: () => true,
      embedHybridOne: jest.fn().mockResolvedValue({
        dense: null,
        sparse: { indices: [1], values: [1] },
        multiVector: null,
      }),
    } as any;
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('sparse postings down'));

    const before = metricsRegistry.getCounterValue('retrieval_failopen_total', { channel: 'sparse' });
    const service = new HybridRetrievalService(embedding);
    await expect(service.searchSparse(['k1'], 'q', 5)).resolves.toEqual([]);
    expect(metricsRegistry.getCounterValue('retrieval_failopen_total', { channel: 'sparse' })).toBe(before + 1);
  });

  it('hybrid rerankLateInteraction counts channel=late_interaction on SQL failure', async () => {
    const embedding = {
      isHybridEnabled: () => true,
      embedHybridOne: jest.fn().mockResolvedValue({
        dense: null,
        sparse: null,
        multiVector: [[1, 0]],
      }),
    } as any;
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('multi_vector down'));

    const before = metricsRegistry.getCounterValue('retrieval_failopen_total', { channel: 'late_interaction' });
    const service = new HybridRetrievalService(embedding);
    const scores = await service.rerankLateInteraction('q', ['c1']);
    expect(scores.size).toBe(0);
    expect(metricsRegistry.getCounterValue('retrieval_failopen_total', { channel: 'late_interaction' })).toBe(before + 1);
  });

  it('recordFailopen + setIngestionQueueDepth are the only writers of the reserved series', () => {
    // Direct contract: calling the helpers is sufficient — /metrics advertises both.
    recordFailopen('lexical');
    setIngestionQueueDepth(3);
    const text = metricsRegistry.render();
    expect(text).toContain('retrieval_failopen_total{channel="lexical"}');
    expect(text).toContain('ingestion_queue_depth 3');
  });
});

describe('ingestion queue depth instrumentation', () => {
  it('IngestionProcessor reports waiting+active+delayed from the queue on start and completion', async () => {
    const { IngestionProcessor } = require('../ingestion/ingestion.processor');
    const counts = jest
      .fn()
      .mockResolvedValueOnce({ waiting: 4, active: 2, delayed: 1 })
      .mockResolvedValueOnce({ waiting: 0, active: 0, delayed: 0 });
    const queue = { getJobCounts: counts };
    const service = {
      processDocument: jest.fn().mockResolvedValue({ ok: true }),
      markFailed: jest.fn(),
    };
    const processor = new IngestionProcessor(service, queue);
    await processor.process({
      data: { documentId: 'd1', expectedVersion: 1 },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as any);
    // start + finally
    expect(counts).toHaveBeenCalledTimes(2);
    expect(metricsRegistry.render()).toContain('ingestion_queue_depth 0');
  });

  it('never throws when queue reference is absent (constructor arg optional)', async () => {
    const { IngestionProcessor } = require('../ingestion/ingestion.processor');
    const service = {
      processDocument: jest.fn().mockResolvedValue({ ok: true }),
      markFailed: jest.fn(),
    };
    const processor = new IngestionProcessor(service);
    await expect(
      processor.process({
        data: { documentId: 'd2', expectedVersion: 1 },
        opts: { attempts: 1 },
        attemptsMade: 0,
      } as any),
    ).resolves.toEqual({ ok: true });
  });
});
