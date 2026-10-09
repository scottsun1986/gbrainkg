/* Real isolated DB + real shared parser HTTP integration. Embedding vectors
 * are deterministic fixtures; this does not measure live model quality. */
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {PassThrough}=require('node:stream');
const {performance}=require('node:perf_hooks');
const AdmZip=require('../../apps/api/node_modules/adm-zip');
const {getPrismaClient,disconnectPrismaClient}=require('../../apps/api/dist/prisma');
const {IngestionController}=require('../../apps/api/dist/ingestion/ingestion.controller');
const {IngestionService}=require('../../apps/api/dist/ingestion/ingestion.service');
const {DocumentLifecycleService}=require('../../apps/api/dist/ingestion/document-lifecycle.service');
const {DocumentVersionStore}=require('../../apps/api/dist/ingestion/document-version-store');
const {QaController}=require('../../apps/api/dist/ingestion/qa.controller');
const {IngestionArtifactsController}=require('../../apps/api/dist/ingestion/ingestion-artifacts.controller');
const {PermissionService}=require('../../apps/api/dist/permission/permission.service');
const {DocumentAclService}=require('../../apps/api/dist/permission/document-acl.service');
const {TableEvidenceService}=require('../../apps/api/dist/retrieval/table-evidence.service');
const {LexicalIndexService}=require('../../apps/api/dist/retrieval/lexical-index.service');
const {readableDocumentWhere}=require('../../apps/api/dist/retrieval/readable-document-scope');
const {runWithRequestContext}=require('../../apps/api/dist/observability/request-context');

(async()=>{
  const timings={tableRows:Number(process.env.INGESTION_TEST_ROWS||10001)};assert(Number.isInteger(timings.tableRows)&&timings.tableRows>=10001&&timings.tableRows<=200001);
  const db=getPrismaClient();assert.match((await db.$queryRaw`SELECT current_database() AS name`)[0].name,/^gbrain_core_opt_test/);
  assert.match(process.env.PARSER_WORKER_URL||'http://127.0.0.1:8100',/^http:\/\/(127\.0\.0\.1|localhost):/,'integration must use a local test worker');
  process.env.CORE_VERSIONING_ENABLED='1';process.env.CONTEXTUAL_RETRIEVAL_ENABLED='false';
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gbrain-ingestion-contract-'));process.env.UPLOAD_ROOT=root;
  const owner=randomUUID(),outsider=randomUUID(),kid=randomUUID();const req={userId:owner},other={userId:outsider};const documentIds=[];
  await db.user.createMany({data:[owner,outsider].map(id=>({id,username:id,email:id+'@invalid.test',displayName:'Ingestion contract fixture'}))});
  await db.knowledgeBase.create({data:{id:kid,type:'personal',name:'Structured ingestion integration',ownerUserId:owner,gitRepoUrl:'test://structured-ingestion'}});
  const queue={getJob:async()=>null,add:async(_name,payload)=>{documentIds.push(payload.documentId);return{id:payload.documentId};}};
  const compiler={onKnowledgeDeleted:async()=>{},onKnowledgePublished:async()=>{}};
  const storage={put:async()=>{throw new Error('local fixture storage');},delete:async()=>{}};
  const permission=new PermissionService();const auth={userIdFromRequest:async request=>request.userId};
  const service=new IngestionService(queue,compiler,{getOcrConfig:async()=>null,getDefault:async()=>null});
  const lexical=new LexicalIndexService();const lifecycle=new DocumentLifecycleService(permission,compiler,service,storage,undefined,undefined,lexical);
  const uploader=new IngestionController(permission,auth,compiler,service,storage,undefined,undefined,lexical);
  const qa=new QaController(auth,permission,service);const artifacts=new IngestionArtifactsController(auth,permission,service,lifecycle);
  const store=new DocumentVersionStore(db);
  const vector=JSON.stringify(Array.from({length:1024},(_,i)=>i===0?1:0));
  const publish=async(documentId)=>{
    const doc=await db.document.findUnique({where:{id:documentId}});
    const result=await service.processDocument(documentId,doc.ingestVersion||doc.version);
    if(result.status==='needs_review')return result;
    assert.equal(result.status,'indexing');assert(result.versionId);
    await db.$executeRaw`UPDATE "BlockArtifact" SET embedding=${vector}::vector,embedding_fingerprint='ingestion-contract-test' WHERE "versionId"=${result.versionId}::uuid`;
    assert.equal(await store.publish(result.versionId,'ingestion-contract-test'),true);
    return db.document.findUnique({where:{id:documentId}});
  };
  try {
    const workbook=path.join(root,'typed.xlsx');
    await promisify(execFile)(process.env.PARSER_TEST_PYTHON||'python3',['-c',
      'import sys,openpyxl\nw=openpyxl.Workbook();s=w.active;s.title="Typed facts";s.append(["key","amount","rate"]);\nfor i in range(int(sys.argv[2])): s.append(["k"+str(i),i,0.15]);s.cell(i+2,3).number_format="0.0%"\nw.save(sys.argv[1])',workbook,String(timings.tableRows)]);
    const bytes=await fs.readFile(workbook);
    await assert.rejects(()=>uploader.uploadDocument(kid,{originalname:'typed.xlsx',size:bytes.length,buffer:bytes},other,{}));
    let started=performance.now();const upload=await uploader.uploadDocument(kid,{originalname:'typed.xlsx',size:bytes.length,buffer:bytes},req,{});
    timings.uploadMilliseconds=performance.now()-started;started=performance.now();let doc=await publish(upload.documents[0].id);timings.parsePublishMilliseconds=performance.now()-started;assert(doc.parserMetadata.structured_tables.length);
    const table=doc.parserMetadata.structured_tables[0];assert(table.artifact_path,'large source must be durable NDJSON');
    const evidence=new TableEvidenceService();
    started=performance.now();const sum=await evidence.execute(owner,{documentId:doc.id,versionId:doc.activeVersionId,tableId:table.id,operation:'sum',column:1});
    timings.aggregateMilliseconds=performance.now()-started;assert.equal(sum.value,(BigInt(timings.tableRows)*BigInt(timings.tableRows-1)/2n).toString());assert.equal(sum.coverage,1);assert.equal(sum.rowsRead,timings.tableRows+1);
    const count=await evidence.execute(owner,{documentId:doc.id,versionId:doc.activeVersionId,tableId:table.id,operation:'count',filters:[{column:1,operator:'gte',value:timings.tableRows-2}]});assert.equal(count.value,'2');
    await assert.rejects(()=>evidence.execute(outsider,{documentId:doc.id,versionId:doc.activeVersionId,tableId:table.id,operation:'count'}));
    const oldVersion=doc.activeVersionId;
    await artifacts.retryUnits(kid,doc.id,req,{unitIds:[doc.parserMetadata.source_units.find(unit=>unit.kind==='table').id]});
    const before=await db.document.findUnique({where:{id:doc.id}});assert.equal(before.activeVersionId,oldVersion);
    doc=await publish(doc.id);assert.notEqual(doc.activeVersionId,oldVersion);assert(doc.parserMetadata.structured_tables[0].artifact_path.includes(`artifacts.v${doc.version}/`));

    const csv=Buffer.from('question,answer,alias\r\n"How many zeros?",0,"zero question"\r\n"Is it false?",false,"false question"');
    const preview=await qa.preview(kid,req,{originalname:'qa.csv',buffer:csv},{mapping:JSON.stringify({question:'question',answer:'answer',aliases:'alias'})});
    assert.equal(preview.validCount,2);assert.equal(preview.rows[0].answer,'0');
    const imported=await qa.import(kid,req,{rows:preview.rows,reviewed:false});
    const candidate=imported.documents[0];assert.equal((await publish(candidate.id)).status,'needs_review');
    await qa.review(kid,candidate.id,req,{approved:true,expectedVersion:1});const publishedQa=await publish(candidate.id);
    const hits=await runWithRequestContext({requestId:randomUUID(),userId:owner},()=>lexical.search([kid],['zero','question'],20));
    assert(hits.some(hit=>hit.documentId===candidate.id),'question aliases must be indexed');
    const block=await db.blockArtifact.findFirst({where:{versionId:publishedQa.activeVersionId}});assert(block.rawContent.endsWith('0'));
    await assert.rejects(()=>qa.import(kid,other,{rows:preview.rows,reviewed:true}));
    const update={...preview.rows[0],idProvided:true,answer:'updated answer',effectiveFrom:'2030-01-01T00:00:00Z'};
    await qa.import(kid,req,{rows:[update],reviewed:false});
    const stillActive=await db.document.findUnique({where:{id:candidate.id}});assert.equal(stillActive.activeVersionId,publishedQa.activeVersionId);assert.equal(stillActive.effectiveFrom,null);
    const listing=await qa.list(kid,req);const listed=listing.items.find(item=>item.id===candidate.id);
    assert.equal(listed.activeQa.answer,'0');assert.equal(listed.pendingQa.answer,'updated answer');assert.equal(listed.qaState,'needs_review');assert.equal(listed.displayEffectiveFrom,update.effectiveFrom);
    await assert.rejects(()=>qa.review(kid,candidate.id,req,{approved:true,expectedVersion:1}));

    const derived=await qa.import(kid,req,{rows:[{id:'derived',question:'Derived fixture?',answer:'source-bound answer',sourceCategory:'document',sourceDocumentId:doc.id,sourceVersionId:doc.activeVersionId}],reviewed:true});
    const derivedDoc=await publish(derived.documents[0].id);assert(await new DocumentAclService(permission).isDocumentReadable(owner,derivedDoc.id));

    const zip=new AdmZip();zip.addFile('bundle/guide.md',Buffer.from('# Guide\n\nREAL-PACKAGE-TEXT\n\n![figure](assets/figure.png)'));zip.addFile('bundle/assets/figure.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8VYAAAAASUVORK5CYII=','base64'));zip.addFile('bundle/nested.zip',Buffer.from('not expanded'));zip.addFile('bundle/unknown.odt',Buffer.from('not supported'));
    const archiveBytes=zip.toBuffer();const bundle=await uploader.uploadDocument(kid,{originalname:'bundle.zip',size:archiveBytes.length,buffer:archiveBytes},req,{});
    assert.equal(bundle.total,1,'referenced images must not become duplicate standalone documents');assert(bundle.manifest.some(item=>item.status==='asset'));assert(bundle.manifest.some(item=>item.reason==='嵌套压缩包未展开'));
    const packageDoc=await publish(bundle.documents[0].id);assert(packageDoc.parserMetadata.assets[0].url);
    const batch=await artifacts.batch(bundle.batchId,req);assert.equal(batch.items.find(item=>item.documentId===packageDoc.id).status,'published');
    await assert.rejects(()=>artifacts.batch(bundle.batchId,other));
    const asset=packageDoc.parserMetadata.assets[0];const output=new PassThrough();const chunks=[];output.on('data',chunk=>chunks.push(chunk));output.setHeader=()=>{};output.status=()=>output;const finished=new Promise((resolve,reject)=>{output.on('end',resolve);output.on('error',reject);});
    await artifacts.asset(kid,packageDoc.id,asset.id,String(packageDoc.version),req,output);await finished;assert(Buffer.concat(chunks).length>0);
    await assert.rejects(()=>artifacts.asset(kid,packageDoc.id,asset.id,String(packageDoc.version),other,new PassThrough()));
    await lifecycle.deleteDocument(owner,kid,packageDoc.id);await assert.rejects(()=>fs.stat(path.join(root,packageDoc.id)));
    await lifecycle.deleteDocument(owner,kid,doc.id);assert.equal(await new DocumentAclService(permission).isDocumentReadable(owner,derivedDoc.id),false);
    const afterScope=await runWithRequestContext({requestId:randomUUID(),userId:owner},()=>readableDocumentWhere(db,owner));
    assert.equal(await db.document.count({where:{AND:[{id:derivedDoc.id},afterScope]}}),0,'Prisma candidate scope must reject stale derived QA before pagination');
    timings.apiMaxRssKiB=process.resourceUsage().maxRSS;timings.workerResourceMetrics=doc.parserMetadata.resource_metrics||null;timings.liveEmbeddingProvider=false;timings.realQueue=false;
    if(process.env.INGESTION_REPORT_PATH)await fs.writeFile(process.env.INGESTION_REPORT_PATH,JSON.stringify(timings,null,2));
    console.log(JSON.stringify(timings));
    console.log('Structured upload → real parser → immutable publication → complete aggregation / aliases → retry / review CAS → package assets / ACL / source invalidation / delete PASS');
  } finally {
    await db.brainChangeEvent.deleteMany({where:{resourceId:{in:[...new Set(documentIds)]}}});
    await db.knowledgeBase.delete({where:{id:kid}});await db.user.deleteMany({where:{id:{in:[owner,outsider]}}});
    await fs.rm(root,{recursive:true,force:true});await disconnectPrismaClient();
  }
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
