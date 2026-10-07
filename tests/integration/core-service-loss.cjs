// Real BullMQ worker SIGKILL, scoped Redis queue loss and application service restart.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { Queue, Worker } = require('../../apps/api/node_modules/bullmq');
const { getPrismaClient, disconnectPrismaClient } = require('../../apps/api/dist/prisma');
const { BrainOutboxService } = require('../../apps/api/dist/brain-compiler/brain-outbox.service');
const { IngestionService } = require('../../apps/api/dist/ingestion/ingestion.service');
const { DocumentVersionStore } = require('../../apps/api/dist/ingestion/document-version-store');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const connection = { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), db: Number(process.env.REDIS_DB || 15), ...(process.env.REDIS_PASS ? { password: process.env.REDIS_PASS } : {}) };
assert(['127.0.0.1', 'localhost', '::1'].includes(connection.host), 'Fault injection is local only');
const prefix = process.env.FAULT_QUEUE_PREFIX;
const queue = name => new Queue(name, { connection, prefix });

if (process.argv[2] === 'worker') {
  const { EnrichmentProcessor } = require('../../apps/api/dist/ingestion/enrichment.processor');
  const { ChunkEmbeddingService } = require('../../apps/api/dist/embedding/chunk-embedding.service');
  const embedding = new ChunkEmbeddingService({
    getConfig: async () => ({ baseUrl: 'https://fixture.invalid', apiKey: 'fixture', modelName: 'fault-fixture', dimensions: 1024, deploymentRevision: 'v1' }),
    embed: async texts => texts.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)),
  });
  if (process.env.FAULT_PAUSE === '1') embedding.embedVersionArtifacts = async () => {
    process.send({ claimed: true }); return new Promise(() => {});
  };
  const processor = new EnrichmentProcessor(embedding, { isEnabled: () => false }, {}, {});
  const worker = new Worker('enrichment-queue', job => processor.process(job), { connection, prefix, lockDuration: 1000, stalledInterval: 1000 });
  worker.on('completed', () => process.send({ completed: true }));
  worker.on('failed', (_, error) => process.send({ error: error.message }));
  process.on('message', async message => { if(message.quit) { await worker.close(); await disconnectPrismaClient(); process.disconnect(); } });
  worker.waitUntilReady().then(() => process.send({ ready: true }));
} else {
  async function main() {
    const db = getPrismaClient();
    assert.match((await db.$queryRaw`SELECT current_database() AS name`)[0].name, /^gbrain_core_opt_test/);
    process.env.CORE_VERSIONING_ENABLED = '1';
    const testPrefix = `gbrain-fault-${randomUUID()}`;
    const queues = ['dirty-compiler-queue', 'enrichment-queue', 'aux-enrichment-queue', 'ingestion-queue'].map(name => new Queue(name, { connection, prefix: testPrefix }));
    const [compilerQ, enrichmentQ, auxiliaryQ, parsingQ] = queues;
    let child;
    const owner=randomUUID(),kb=randomUUID(),doc=randomUUID(),legacy=randomUUID();
    const created = new Set();
    const launch = pause => new Promise((resolve,reject) => {
      child = fork(__filename, ['worker'], { env: { ...process.env, FAULT_QUEUE_PREFIX: testPrefix, FAULT_PAUSE: pause?'1':'0', REDIS_DB: String(connection.db) }, stdio: ['ignore','ignore','ignore','ipc'] });
      const timer=setTimeout(()=>reject(new Error('Worker startup timeout')),10000);
      child.once('message',message=>{ clearTimeout(timer);message.error?reject(new Error(message.error)):resolve(child); });
    });
    const message = predicate => new Promise((resolve,reject) => {
      const target=child;const timer=setTimeout(()=>{target.off('message',handler);reject(new Error('Worker progress timeout'));},20000);
      const handler=value=>{if(value.error || predicate(value)){clearTimeout(timer);target.off('message',handler);value.error?reject(new Error(value.error)):resolve(value);}};
      target.on('message',handler);
    });
    try {
      await db.user.create({data:{id:owner,username:owner,displayName:'Fault fixture',email:owner+'@invalid.test'}});
      await db.knowledgeBase.create({data:{id:kb,type:'personal',name:'Fault fixture',ownerUserId:owner,gitRepoUrl:'test://fault'}});
      await db.document.create({data:{id:doc,kbId:kb,title:'Fault publication',mdPath:doc+'.md',sourceType:'text',ingestVersion:1}});
      const version = await new DocumentVersionStore(db).stage({documentId:doc,kbId:kb,number:1,sourceHash:'fault-source',title:'Fault publication',mdPath:doc+'.md',parser:'fixture',publicationData:{},blocks:[{ord:0,content:'Durable fault fixture source',rawContent:'Durable fault fixture source',tokenCount:5,charStart:0,charEnd:27}],passed:true});
      const events=await db.brainChangeEvent.findMany({where:{eventType:'enrichment_request',resourceId:doc}});
      assert.equal(events.length,1,'staging must atomically persist one enrichment outbox event');
      const event=events[0];
      assert.equal(event.payload.versionId,version.id);
      assert.equal(event.payload.version,version.number);
      assert.equal(event.payload.kbId,kb);
      created.add(event.id);
      // The shared isolated DB contains other integration fixtures' outbox
      // records. Restrict only test candidate discovery, preserving the real
      // dispatcher recovery/lease/queue writes for this event.
      const dispatcher=()=>{
        const service=new BrainOutboxService(compilerQ,enrichmentQ,auxiliaryQ);
        service.prisma={brainChangeEvent:{
          findMany:args=>db.brainChangeEvent.findMany({...args,where:{AND:[args.where,{id:event.id}]}}),
          updateMany:args=>db.brainChangeEvent.updateMany({...args,where:{AND:[args.where,{id:event.id}]}}),
        }};
        return service;
      };
      await launch(true);
      const claimed=message(value=>value.claimed);
      await dispatcher().dispatchPending();
      const queued=await enrichmentQ.getJob(`enrichment-outbox-${event.id}`);
      assert(queued,'durable event must enqueue the version publication job');
      assert.equal(queued.data.versionId,version.id);
      assert.equal(queued.data.expectedVersion,version.number);
      assert.equal(queued.data.documentId,doc);
      assert.equal(queued.data.kbId,kb);
      await claimed;
      console.log('Service loss: production version job claimed; killing real worker');
      assert.equal((await db.brainChangeEvent.findUnique({where:{id:event.id}})).status,'processing');
      await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');});child=null;
      await enrichmentQ.obliterate({force:true}); // Only this UUID prefix, never FLUSHDB.
      assert.equal(await enrichmentQ.getJob(`enrichment-outbox-${event.id}`),undefined);
      // Restart production dispatcher as a new service instance. Its durable
      // database event survives both the dead process and lost Redis job.
      const restarted=dispatcher();
      await restarted.dispatchPending();
      console.log('Service loss: Redis job removed; durable dispatcher replayed it');
      await launch(false);
      for(let i=0;i<100;i++) { if((await db.brainChangeEvent.findUnique({where:{id:event.id}})).status==='completed')break;await sleep(100); }
      const published=await db.document.findUnique({where:{id:doc}});
      assert.equal(published.activeVersionId,version.id);assert.equal(published.status,'published');
      const done=await db.brainChangeEvent.findUnique({where:{id:event.id}});
      assert.equal(done.status,'completed');assert.equal(done.retryCount,1);
      await restarted.dispatchPending();
      assert.equal((await db.documentVersion.findMany({where:{documentId:doc,state:'published'}})).length,1,'replay must not double publish');
      console.log('Service loss: immutable version published exactly once after restart');
      // Exercise the actual startup/watchdog recovery body against a stale
      // parsing record whose original queue task has been lost.
      await db.document.create({data:{id:legacy,kbId:kb,title:'Stale parser',mdPath:legacy+'.md',sourceType:'text',rawFileOid:'fault-fixture.txt',status:'parsing',updatedAt:new Date(Date.now()-600000)}});
      const ingestion=new IngestionService(parsingQ,{onKnowledgePublished:async()=>{}},{},undefined,undefined,undefined,enrichmentQ);
      await ingestion.onModuleInit();
      assert(await parsingQ.getJob(`ingest-${legacy}-v1`),'service restart must recover missing parser task');
      await parsingQ.obliterate({force:true});
      await ingestion.recoverStaleIngestions();
      assert(await parsingQ.getJob(`ingest-${legacy}-v1`),'watchdog body must recover without another service restart');
      ingestion.onModuleDestroy();
      console.log(JSON.stringify({worker_sigkill:true,redis_job_loss:true,durable_outbox_replay:true,version_published_once:true,startup_parser_recovery:true,periodic_recovery_body:true}));
    } finally {
      if(child)child.kill('SIGKILL');
      for(const q of queues){await q.obliterate({force:true}).catch(()=>{});await q.close();}
      await db.brainChangeEvent.deleteMany({where:{OR:[{id:{in:[...created]}},{resourceId:{in:[doc,legacy]}}]}});
      await db.knowledgeBase.deleteMany({where:{id:kb}});await db.user.deleteMany({where:{id:owner}});
      await disconnectPrismaClient();
    }
  }
  main().catch(error=>{console.error(error.stack);process.exitCode=1;});
}
