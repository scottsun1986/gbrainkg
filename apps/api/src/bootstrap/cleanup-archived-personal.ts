import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Queue } from 'bullmq';
import { PermissionService } from '../permission/permission.service';
import { ModelConfigService } from '../model-config.service';
import { BrainScopeService } from '../brain-compiler/brain-scope.service';
import { BrainOutboxService } from '../brain-compiler/brain-outbox.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { GraphRagService } from '../graph-rag/graph-rag.service';
import { RaptorService } from '../raptor/raptor.service';
import { LexicalIndexService } from '../retrieval/lexical-index.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { ArchivedPersonalCleanupService, ArchivedCleanupPlan } from '../ingestion/archived-personal-cleanup.service';
import { runAsService } from '../db/service-principal';
import { getPrismaClient, disconnectPrismaClient } from '../prisma';

export function assertLocalCleanupConfiguration(execute: boolean) {
  const target = new URL(process.env.DATABASE_URL || '');
  const expectedDatabase = process.env.ARCHIVED_CLEANUP_LOCAL_DATABASE;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !expectedDatabase ||
      decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase)
    throw new Error('Explicit local database scope required (ARCHIVED_CLEANUP_LOCAL_DATABASE)');
  if (!process.env.UPLOAD_ROOT || !process.env.BRAIN_REPO_BASE_PATH ||
      !isAbsolute(process.env.UPLOAD_ROOT) || !isAbsolute(process.env.BRAIN_REPO_BASE_PATH))
    throw new Error('Explicit absolute runtime UPLOAD_ROOT and BRAIN_REPO_BASE_PATH required');
  if (process.env.MINIO_ENDPOINT) {
    const endpoint = new URL(process.env.MINIO_ENDPOINT.includes('://') ? process.env.MINIO_ENDPOINT : `http://${process.env.MINIO_ENDPOINT}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Local object storage required');
  }
  if (execute && process.env.ARCHIVED_CLEANUP_ENABLE !== '1') throw new Error('Cleanup kill-switch is closed');
}

async function main() {
  const args = process.argv.slice(2);
  const cancellation = new AbortController();
  process.once('SIGINT', () => cancellation.abort());
  process.once('SIGTERM', () => cancellation.abort());
  const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; };
  const actor = value('--actor');
  const kbId = value('--kb-id');
  const kbName = value('--kb-name');
  const file = value('--plan');
  if (!actor || !kbId || !kbName || !file) throw new Error('--actor --kb-id --kb-name --plan required');
  const execute = args.includes('--execute');
  // Local maintenance only. Explicit database basename must match the runtime URL.
  // No defaults or environment names can silently authorize a remote target.
  getPrismaClient(); // Existing loader resolves the same app .env and RLS role as runtime.
  assertLocalCleanupConfiguration(execute);
  // Construct only business services and Queue clients. No Nest application,
  // Processor/Worker, lifecycle hooks, scheduler or HTTP listener is created.
  const connection = { host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT || 6379),
    db: Number(process.env.REDIS_DB || 0), ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}) };
  if (!['localhost', '127.0.0.1', '::1'].includes(connection.host)) throw new Error('Local Redis required');
  const queues = ['ingestion-queue', 'enrichment-queue', 'aux-enrichment-queue', 'dirty-compiler-queue']
    .map(name => new Queue(name, { connection }));
  const [ingestion, enrichment, auxiliary, compilerQueue] = queues;
  const permissions = new PermissionService();
  const config = new ModelConfigService();
  const scope = new BrainScopeService(permissions, config);
  const outbox = new BrainOutboxService(compilerQueue, enrichment, auxiliary);
  const compiler = new BrainCompilerService(compilerQueue, permissions, config, scope, outbox);
  const service = new ArchivedPersonalCleanupService(permissions, compiler, new GraphRagService(), new RaptorService(),
    new LexicalIndexService(), new ObjectStorageService(), ingestion, enrichment, auxiliary, compilerQueue);
  try {
    await runAsService('archived-personal-cleanup', async () => {
      if (!execute && !args.includes('--verify')) {
        const plan = await service.plan(actor, kbId, kbName);
        await writeFile(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ dryRun: true, operationId: plan.operationId, kbId, kbName,
          eligible: plan.documents.length, retainedReady: plan.retainedReady, planFile: file }));
      } else {
        const plan: ArchivedCleanupPlan = JSON.parse(await readFile(file, 'utf8'));
        if (plan.kbId !== kbId || plan.kbName !== kbName || plan.ownerUserId !== actor)
          throw new Error('Explicit command scope differs from reviewed plan');
        const offset = Number(value('--offset') || '0');
        const batchSize = Number(value('--batch-size') || '1');
        const result = args.includes('--verify') ? await service.verifyBatch(actor, plan, offset, batchSize) :
          await service.executeBatch(actor, plan, offset, batchSize, cancellation.signal);
        console.log(JSON.stringify({ operationId: plan.operationId, kbId, offset, result }));
      }
    });
  } finally { await Promise.all(queues.map(queue => queue.close())); await disconnectPrismaClient(); }
}
if (require.main === module) main().catch(async error => { console.error(error.message); await disconnectPrismaClient(); process.exitCode = 1; });
