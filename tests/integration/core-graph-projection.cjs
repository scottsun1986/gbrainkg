const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {getPrismaClient,disconnectPrismaClient}=require('../../apps/api/dist/prisma');
const {runAsService}=require('../../apps/api/dist/db/service-principal');
const {reconcileIncrementalGraph}=require('../../apps/api/dist/graph-rag/incremental-projection');
async function main(){
 const db=getPrismaClient();const [identity]=await db.$queryRaw`SELECT current_database() AS name`;assert.match(identity.name,/^gbrain_core_opt_test/);
 const userId=randomUUID(),kbId=randomUUID(),docIds=[randomUUID(),randomUUID()];
 await db.user.create({data:{id:userId,username:userId,email:`${userId}@invalid.test`,displayName:'Graph fixture'}});
 await db.knowledgeBase.create({data:{id:kbId,type:'personal',name:'Graph test',ownerUserId:userId,gitRepoUrl:'test://graph'}});
 try{
  for(const id of docIds){await db.document.create({data:{id,kbId,title:id,mdPath:id+'.md',sourceType:'upload',status:'published',contentHash:id}});}
  const extract=async doc=>({entities:[{name:'Shared',type:'person',description:'distinct source identity'},{name:doc.id,type:'document'}],relations:[{sourceName:'Shared',targetName:doc.id,relationType:'mentions',provenanceDocId:doc.id,snippet:'original text',documentVersion:doc.version}]});
  const reconcile=(fn=extract,reuse=true)=>runAsService('graph-test',()=>reconcileIncrementalGraph(db,kbId,['model-rev'],reuse,fn));
  const first=await reconcile();assert.equal(first.extracted,2);assert.equal(first.changed,5);
  const untouched=await db.graphEntity.findFirst({where:{kbId,name:docIds[1]}});
  assert.deepEqual(await reconcile(),{extracted:0,changed:0});
  await db.document.update({where:{id:docIds[0]},data:{version:2,contentHash:'revision-two'}});
  const delta=await reconcile();assert.equal(delta.extracted,1);assert.equal(delta.changed,4);
  const nextUntouched=await db.graphEntity.findUnique({where:{id:untouched.id}});assert.equal(nextUntouched.updatedAt.getTime(),untouched.updatedAt.getTime());
  await db.document.update({where:{id:docIds[0]},data:{lifecycleStatus:'repealed',effectiveTo:new Date()}});await reconcile();
  const shared=await db.graphEntity.findFirst({where:{kbId,name:'Shared'}});
  const deps=await db.$queryRaw`SELECT "sourceDocumentId" FROM "ArtifactDependency" WHERE "artifactId"=${shared.id}`;
  assert.equal(deps.length,1);assert.equal(deps[0].sourceDocumentId,docIds[1]);
  let changed=false;
  await assert.rejects(reconcile(async doc=>{if(!changed){changed=true;await db.document.update({where:{id:doc.id},data:{contentHash:'concurrent-edit'}});}return extract(doc);},false),/versions changed/);
  console.log('incremental graph delta, withdrawal, dependency replacement and concurrent version fence passed');
 }finally{
  await db.graphCommunity.deleteMany({where:{kbId}});await db.graphRelation.deleteMany({where:{kbId}});await db.graphEntity.deleteMany({where:{kbId}});
  await db.document.deleteMany({where:{kbId}});await db.knowledgeBase.delete({where:{id:kbId}});await db.user.delete({where:{id:userId}});await disconnectPrismaClient();
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
