// Run against the dedicated disposable audit Redis only, never a business queue.
require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Queue, Worker } = require('bullmq');
const { BrainOutboxService } = require('./src/brain-compiler/brain-outbox.service');

async function main() {
  const connection = { host: '127.0.0.1', port: 56389, maxRetriesPerRequest: null };
  const name = `outbox-audit-${randomUUID()}`;
  const queue = new Queue(name, { connection });
  const service = new BrainOutboxService(queue);
  const prisma = service.prisma;
  service.prisma = { brainChangeEvent: { findMany: async () => [{ id: 'fixture', eventType: 'perm_revoke' }] } };
  let executions = 0;
  let worker;
  const until = async predicate => {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('audit deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await service.dispatchPending();
    await service.dispatchPending();
    assert.equal(await queue.getJobCountByTypes('waiting', 'prioritized'), 1);
    const job = await queue.getJob('outbox-event-fixture');
    // Simulate exhausted worker attempts, then exercise the real Job.retry API.
    await job.changeDelay(0).catch(() => {});
    worker = new Worker(name, async () => { executions++; throw new Error('fixture failure'); }, { connection });
    worker.on('error', () => {});
    await until(async () => (await job.getState()) === 'failed');
    await worker.close();
    worker = undefined;
    assert.equal(executions, 3);
    await service.dispatchPending();
    assert.ok(['waiting', 'prioritized'].includes(await job.getState()));
    worker = new Worker(name, async () => { executions++; return 'recovered'; }, { connection });
    worker.on('error', () => {});
    await until(async () => (await job.getState()) === 'completed');
    assert.equal(executions, 4);
    console.log('PASS real Redis: stable ID deduplication, exhausted failure replay, recovered completion');
  } finally {
    if (worker) await worker.close();
    await queue.close();
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
