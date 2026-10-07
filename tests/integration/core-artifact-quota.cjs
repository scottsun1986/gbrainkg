// Current application authority at the historical 2232 artifacts x 908 sources scale.
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {getPrismaClient,disconnectPrismaClient}=require('../../apps/api/dist/prisma');
const {filterReadableArtifacts}=require('../../apps/api/dist/permission/artifact-read-guard');
const {admitModelCall}=require('../../apps/api/dist/retrieval/model-admission');
const {withAuthorizedRequest}=require('../../apps/api/dist/permission/authorization-revision');

async function main(){
 const db=getPrismaClient();assert.match((await db.$queryRaw`SELECT current_database() AS name`)[0].name,/^gbrain_core_opt_test/);
 const owner=randomUUID(),reader=randomUUID(),inactive=randomUUID(),kb=randomUUID(),seed=randomUUID();
 const artifacts=Array.from({length:2232},(_,i)=>createHash('md5').update(seed+'artifact'+(i+1)).digest('hex')).map(hex=>`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`);
 const source=createHash('md5').update(seed+'source1').digest('hex');const firstSource=`${source.slice(0,8)}-${source.slice(8,12)}-${source.slice(12,16)}-${source.slice(16,20)}-${source.slice(20)}`;
 const times={};const quotaResource='https://quota-'+seed+'.invalid';
 const quotaKey=createHash('sha256').update(quotaResource).digest('hex');
 console.log('Artifact scale: isolated database verified; preparing users and KB');
 try{
  for(const id of [owner,reader,inactive])await db.user.create({data:{id,username:id,displayName:'Scale fixture',email:id+'@invalid.test',...(id===inactive?{status:'disabled'}:{})}});
  await db.knowledgeBase.create({data:{id:kb,type:'industry',name:'Artifact scale fixture',ownerUserId:owner,gitRepoUrl:'test://artifact-scale'}});
  await db.industryGrant.create({data:{kbId:kb,subjectType:'user',subjectId:reader,grantedById:owner}});
  console.log('Artifact scale: inserting 908 published sources');
  await db.$executeRaw`INSERT INTO "Document"(id,"kbId","mdPath",title,"sourceType",status,"updatedAt","contentHash") SELECT md5(${seed} || 'source' || i)::uuid,${kb}::uuid,i || '.md',i::text,'upload','published',now(),'hash' FROM generate_series(1,908) i`;
  console.log('Artifact scale: inserting 2232 artifacts');
  await db.$executeRaw`INSERT INTO "RaptorNode"(id,"kbId",title,content) SELECT md5(${seed} || 'artifact' || i)::uuid,${kb}::uuid,i::text,'summary' FROM generate_series(1,2232) i`;
  const beforeExplicit=await db.$queryRaw`SELECT count(*)::int AS count FROM "ArtifactDependency" a JOIN "RaptorNode" r ON r.id::text=a."artifactId" WHERE r."kbId"=${kb}::uuid`;
  assert.equal(beforeExplicit[0].count,0,'plain app-layer fixture writes must not inherit obsolete artifact_inputs GUC manifests');
  console.log('Artifact scale: created 2232 artifacts and 908 sources');
  for(let start=1;start<=2232;start+=256){
   const end=Math.min(2232,start+255);
   await db.$transaction(async tx=>{
    await tx.$executeRaw`SET LOCAL statement_timeout=120000`;
    await tx.$executeRaw`INSERT INTO "ArtifactDependency"(id,"artifactId","artifactKind","sourceDocumentId","sourceHash") SELECT gen_random_uuid(),r.id::text,'RaptorNode',d.id,'hash:1' FROM "RaptorNode" r CROSS JOIN "Document" d WHERE r."kbId"=${kb}::uuid AND d."kbId"=${kb}::uuid AND r.title::int BETWEEN ${start} AND ${end}`;
   },{timeout:125000,maxWait:2000});
   console.log(`Artifact scale: persisted ${end*908}/2026656 dependencies`);
  }
  await db.$executeRaw`INSERT INTO "ArtifactManifest"("artifactId","artifactKind","expectedCount") SELECT id::text,'RaptorNode',908 FROM "RaptorNode" WHERE "kbId"=${kb}::uuid ON CONFLICT("artifactId") DO UPDATE SET "expectedCount"=EXCLUDED."expectedCount"`;
  const loaded=await db.$queryRaw`SELECT count(*)::int AS count FROM "ArtifactDependency" a JOIN "RaptorNode" r ON r.id::text=a."artifactId" WHERE r."kbId"=${kb}::uuid`;
  assert.equal(loaded[0].count,2232*908,'exact cross product with no inherited trigger dependencies');
  console.log('Artifact scale: dependency loading complete; validating application ACL');
  const check=async(label,expected,user=reader)=>{
   const started=performance.now();
   const allowed=await db.$transaction(tx=>filterReadableArtifacts(user,artifacts.map(id=>({id,kbId:kb})),'RaptorNode',tx),{isolationLevel:'RepeatableRead',timeout:60000,maxWait:2000});
   times[label]=Math.round(performance.now()-started);assert.equal(allowed.size,expected,label);
   console.log(`Artifact scale: ${label} ${allowed.size} allowed in ${times[label]}ms`);
  };
  await check('all_sources_readable',2232);
  await db.document.update({where:{id:firstSource},data:{aclMode:'restricted'}});await check('one_source_acl_denies_every_artifact',0);
  await db.document.update({where:{id:firstSource},data:{aclMode:'inherit',contentHash:'drift'}});await check('one_hash_drift_denies_every_artifact',0);
  await db.document.update({where:{id:firstSource},data:{contentHash:'hash',effectiveTo:new Date(Date.now()-1000)}});await check('expired_source_denies_every_artifact',0);
  await db.document.update({where:{id:firstSource},data:{effectiveTo:null}});
  await db.$executeRaw`DELETE FROM "ArtifactManifest" WHERE "artifactId"=${artifacts[0]}`;
  await db.$executeRaw`DELETE FROM "ArtifactDependency" WHERE "artifactId"=${artifacts[1]} AND "sourceDocumentId"=${firstSource}::uuid`;
  await check('missing_manifest_and_incomplete_sources',2230);
  await check('anonymous_denied',0,'');
  await db.industryGrant.deleteMany({where:{kbId:kb}});await check('library_revocation_denies_every_artifact',0);
  process.env.CORE_AUTH_ENFORCE='1';process.env.MODEL_HOST_RPM='3';process.env.MODEL_HOST_INPUT_TPM='100';process.env.HOST_INSTANCE_COUNT='1';process.env.MODEL_QUOTA_RESOURCE_ID=quotaResource;
  const admit=(user,model,tokens)=>withAuthorizedRequest(user,()=>admitModelCall(quotaResource+'/v1/chat/completions',model,tokens));
  const decisions=await Promise.allSettled(Array.from({length:8},(_,i)=>admit(i%2?reader:owner,i%2?'chat':'embedding',20)));
  assert.equal(decisions.filter(row=>row.status==='fulfilled').length,3,'quota is atomic and shared across users and model names');
  await assert.rejects(()=>admit(inactive,'chat',1),/revoked/);
  await assert.rejects(()=>admitModelCall(quotaResource,'chat',1),/Authorized model caller/);
  const counts=await db.$queryRaw`SELECT sum(requests)::int AS requests,sum(tokens)::int AS tokens FROM "ModelQuotaBucket" WHERE key=${quotaKey}`;
  assert.equal(counts[0].requests,3);assert.equal(counts[0].tokens,60);
  process.env.MODEL_QUOTA_RESOURCE_ID=quotaResource+'-tokens';
  await withAuthorizedRequest(owner,()=>admitModelCall(quotaResource,'chat',90));
  await assert.rejects(()=>withAuthorizedRequest(reader,()=>admitModelCall(quotaResource,'other-model',11)),/quota exhausted/);
  console.log(JSON.stringify({artifacts:2232,sources:908,dependency_rows:2232*908,application_guard:true,checks_ms:times,atomic_shared_quota:true,inactive_and_anonymous_denied:true,token_limit:true}));
 }finally{
  console.log('Artifact scale: cleaning scoped fixture');
  await db.$executeRaw`DELETE FROM "ArtifactDependency" WHERE "artifactId" IN(SELECT id::text FROM "RaptorNode" WHERE "kbId"=${kb}::uuid)`;
  await db.$executeRaw`DELETE FROM "ArtifactManifest" WHERE "artifactId" IN(SELECT id::text FROM "RaptorNode" WHERE "kbId"=${kb}::uuid)`;
  await db.$executeRaw`DELETE FROM "ModelQuotaBucket" WHERE key IN(${quotaKey},${createHash('sha256').update(quotaResource+'-tokens').digest('hex')})`;
  await db.knowledgeBase.deleteMany({where:{id:kb}});await db.user.deleteMany({where:{id:{in:[owner,reader,inactive]}}});await disconnectPrismaClient();
 }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
