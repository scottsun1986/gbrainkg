const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {getPrismaClient,disconnectPrismaClient}=require('../../apps/api/dist/prisma');
const {DocumentVersionStore}=require('../../apps/api/dist/ingestion/document-version-store');
const {ChunkEmbeddingService}=require('../../apps/api/dist/embedding/chunk-embedding.service');
const {IngestionService}=require('../../apps/api/dist/ingestion/ingestion.service');
(async()=>{
 const db=getPrismaClient();assert.match((await db.$queryRaw`SELECT current_database() AS name`)[0].name,/^gbrain_core_opt_test/);
 process.env.CORE_VERSIONING_ENABLED='1';process.env.CONTEXTUAL_RETRIEVAL_ENABLED='false';
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gbrain-version-claim-'));process.env.UPLOAD_ROOT=root;
 const uid=randomUUID(),kid=randomUUID(),did=randomUUID();await fs.mkdir(path.join(root,did));
 const text='# Replacement source\n\nThis immutable publication fixture verifies that an existing published version remains searchable while replacement parsing builds a new version. The verified replacement anchor is CLAIM-COMPLETED-2026.\n';
 const file=path.join(root,did,'replacement.txt');await fs.writeFile(file,text);
 await db.user.create({data:{id:uid,username:uid,displayName:'Replacement fixture',email:uid+'@invalid.test'}});
 await db.knowledgeBase.create({data:{id:kid,type:'personal',name:'Isolated replacement claim',ownerUserId:uid,gitRepoUrl:'test://replacement'}});
 try {
  await db.document.create({data:{id:did,kbId:kid,title:'Replacement fixture',sourceType:'text',mdPath:did+'/old.md',rawFileOid:file,ingestVersion:1}});
  const store=new DocumentVersionStore(db),old=await store.stage({documentId:did,kbId:kid,number:1,sourceHash:'old',title:'Old fixture',mdPath:did+'/old.md',parser:'test',publicationData:{},blocks:[{ord:0,content:'old source',rawContent:'old source',tokenCount:3,charStart:0,charEnd:10}],passed:true});
  const embed=async(id)=>db.$executeRaw`UPDATE "BlockArtifact" SET embedding=${JSON.stringify(Array.from({length:1024},(_,i)=>i===0?1:0))}::vector,embedding_fingerprint='replacement-integration-model' WHERE "versionId"=${id}::uuid`;
  await embed(old.id);await store.publish(old.id,'replacement-integration-model');
  await db.document.update({where:{id:did},data:{ingestVersion:2}});
  const service=new IngestionService({}, {}, {getOcrConfig:async()=>null,getDefault:async()=>null});
  const staged=await service.processDocument(did,2);
  assert.equal(staged.status,'indexing','replacement parsing must not be a superseded empty-update no-op');assert(staged.versionId);
  const building=await db.document.findUnique({where:{id:did}});assert.equal(building.activeVersionId,old.id);assert.equal(building.buildingVersionId,staged.versionId);assert.equal(building.status,'published');
  const blocks=await db.blockArtifact.findMany({where:{versionId:staged.versionId}});assert(blocks.length);for(const b of blocks)assert.equal(b.rawContent,text.slice(b.charStart,b.charEnd));
  const embeddingService={getConfig:async()=>({baseUrl:'https://integration.invalid',apiKey:'fixture',modelName:'integration-model',dimensions:1024,deploymentRevision:'test-v1'}),embed:async texts=>texts.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0))};
  const result=await new ChunkEmbeddingService(embeddingService).embedVersionArtifacts(staged.versionId);
  assert.equal(result.missing,0,'actual block embedding writes must preserve immutable metadata');
  const after=await db.blockArtifact.findMany({where:{versionId:staged.versionId}});assert.deepEqual(after.map(b=>b.metadata),blocks.map(b=>b.metadata));
  assert.equal(await store.publish(staged.versionId,result.fingerprint),true);
  assert.equal((await db.document.findUnique({where:{id:did}})).activeVersionId,staged.versionId);
  console.log('Real replacement ingestion claim, old-version availability, verified source spans and new publication PASS');
 } finally {
  await db.brainChangeEvent.deleteMany({where:{resourceId:did}});await db.knowledgeBase.delete({where:{id:kid}});await db.user.delete({where:{id:uid}});await fs.rm(root,{recursive:true,force:true});await disconnectPrismaClient();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
