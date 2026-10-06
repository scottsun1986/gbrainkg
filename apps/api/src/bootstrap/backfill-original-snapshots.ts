import { createHash } from 'node:crypto';
import { mkdir,readFile,realpath,stat,writeFile } from 'node:fs/promises';
import { resolve,dirname,sep } from 'node:path';
import { getPrismaClient,disconnectPrismaClient } from '../prisma';
import { runAsService } from '../db/service-principal';
import { withServiceContext } from '../db/tenant-context.service';
import { originalSpan } from '../ingestion/original-block-snapshot';
import { uploadRoot } from '../storage/upload-paths';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function main() {
 const root=await realpath(uploadRoot());
 const db=getPrismaClient();let cursor:string|undefined;
 const report={documents:0,created:0,existing:0,missingSources:[] as Array<{id:string;title:string}>};
 await runAsService('original-source-backfill',async()=>{
  for (;;) {
   const docs=await db.document.findMany({ where:{status:'published',activeVersionId:{not:null}},include:{activeVersion:{include:{blocks:{orderBy:{ord:'asc'},include:{originalSnapshot:true}}}}},orderBy:{id:'asc'},take:100,...(cursor?{cursor:{id:cursor},skip:1}:{}) });
   if (!docs.length) break;
   for (const doc of docs) {
    const blocks=doc.activeVersion!.blocks.filter(block=>block.rawContent==null && !block.originalSnapshot);if (!blocks.length) {report.existing+=doc.activeVersion!.blocks.length;continue;}
    let source:string;
    try {
     const path=await realpath(resolve(root,doc.activeVersion!.mdPath));
     if (!path.startsWith(root+sep) || (await stat(path)).size>64*1024*1024) throw new Error('Invalid original source path');
     source=await readFile(path,'utf8');
    } catch(error) {
     if ((error as any)?.code!=='ENOENT') throw error;
     report.missingSources.push({id:doc.id,title:doc.title});continue;
    }
    const parsedHash=hash(source),sourcePath=`${doc.id}/original.v${doc.version}.${parsedHash}.md`,snapshotFile=resolve(root,sourcePath);
    await mkdir(dirname(snapshotFile),{recursive:true});
    try {await writeFile(snapshotFile,source,{flag:'wx',mode:0o600});} catch(error) {if ((error as any)?.code!=='EEXIST' || hash(await readFile(snapshotFile,'utf8'))!==parsedHash) throw error;}
    const rows=blocks.map(block=>{const rawContent=originalSpan(source,block.charStart,block.charEnd);return {blockId:block.id,versionId:block.versionId,charStart:block.charStart,charEnd:block.charEnd,rawContent,rawHash:hash(rawContent),parsedHash,sourcePath};});
    await withServiceContext(db,async tx=>{
     await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${doc.id}::uuid FOR UPDATE`;
     const current=await tx.document.findUnique({where:{id:doc.id}});
     if (current?.status!=='published' || current.activeVersionId!==doc.activeVersionId || current.contentHash!==doc.contentHash || current.mdPath!==doc.mdPath) throw new Error('Source changed during original backfill; rerun');
     for(let i=0;i<rows.length;i+=100) await tx.originalBlockSnapshot.createMany({data:rows.slice(i,i+100),skipDuplicates:true});
    });report.created+=rows.length;report.documents++;
   }
   cursor=docs[docs.length-1].id;
   console.log(JSON.stringify({progress:report.documents,created:report.created,missing:report.missingSources.length}));
  }
 });
 console.log(JSON.stringify(report));
 if(report.missingSources.length && !process.argv.includes('--allow-missing-sources')) throw new Error('Missing source files; snapshots were not fabricated');
 await disconnectPrismaClient();
}
main().catch(async error=>{console.error(error.message);await disconnectPrismaClient();process.exitCode=1;});
