import { Queue } from 'bullmq';

/** Shared durable enqueue contract for uploads and independent version creation. */
export async function enqueueDocumentParse(queue: Queue, documentId: string, version: number, reason: string, priority = 10): Promise<void> {
  const jobId = `ingest-${documentId}-v${version}`;
  const existing = await queue.getJob?.(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed' || state === 'completed') await existing.remove();
  }
  await queue.add('parse-document', { documentId, reason, expectedVersion: version }, {
    jobId, attempts: 3, backoff: { type: 'exponential', delay: 3_000 },
    removeOnComplete: 200, removeOnFail: 500, priority,
  });
}
