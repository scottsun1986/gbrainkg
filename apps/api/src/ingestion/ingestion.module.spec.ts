import { Test } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { IngestionModule } from './ingestion.module';
import { BrainCompilerModule } from '../brain-compiler/brain-compiler.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { AuditModule } from '../audit/audit.module';

/** Queue stubs keep the probe offline: compile must not open BullMQ sockets. */
const stubQueue = {
  add: jest.fn(), getJob: jest.fn(async () => null), getJobs: jest.fn(async () => []),
  removeJob: jest.fn(), close: jest.fn(async () => undefined),
};

/**
 * The ingestion module graph must resolve. ArchivedPersonalCleanupService is a
 * maintenance-only service built directly by bootstrap/cleanup-archived-personal.ts;
 * registering it here previously injected a queue token this module does not own
 * and crashed the whole API at bootstrap. DI graph regressions are invisible to
 * unit tests that construct services by hand, so compile the real graph.
 */
describe('IngestionModule dependency graph', () => {
  it('resolves every provider with the queues AppModule makes available', async () => {
    const builder = Test.createTestingModule({
      imports: [
        BullModule.forRoot({ connection: { host: '127.0.0.1', port: 6379, lazyConnect: true } }),
        BrainCompilerModule,
        EmbeddingModule,
        AuditModule,
        IngestionModule,
      ],
    });
    for (const name of ['ingestion-queue', 'enrichment-queue', 'aux-enrichment-queue', 'dirty-compiler-queue']) {
      builder.overrideProvider(getQueueToken(name)).useValue(stubQueue);
    }
    const moduleRef = await builder.compile();
    expect(moduleRef.get(IngestionModule, { strict: false })).toBeDefined();
  }, 60000);
});