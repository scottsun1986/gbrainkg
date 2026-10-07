import { createHash,randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { withServiceContext } from '../db/tenant-context.service';
import { getRequestContext } from '../observability/request-context';
import type { ExtractedEntity,ExtractedRelation } from './graph-rag.service';
import { graphDocumentChunkLimit } from './extraction-budget';
const hash=(value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface GraphInput { documentId:string;versionId:string|null;sourceHash:string }
export interface GraphShard { input:GraphInput;entities:ExtractedEntity[];relations:ExtractedRelation[] }

/** The worker already checked scope and input versions. Dependency replacement
 * is application-owned; legacy trigger GUCs are no longer a service identity. */
async function replaceProjectionInputs(tx:any, artifactId:string, artifactKind:string, inputs:GraphInput[]) {
  await tx.artifactDependency.deleteMany({ where:{ artifactId } });
  await tx.artifactDependency.createMany({ data:inputs.map(input=>({
    artifactId,artifactKind,sourceDocumentId:input.documentId,
    sourceVersionId:input.versionId,sourceHash:input.sourceHash,
  })) });
  await tx.$executeRaw`INSERT INTO "ArtifactManifest" ("artifactId","artifactKind","expectedCount")
    VALUES (${artifactId},${artifactKind},${inputs.length})
    ON CONFLICT ("artifactId") DO UPDATE SET "artifactKind"=EXCLUDED."artifactKind","expectedCount"=EXCLUDED."expectedCount"`;
}

/** Surface labels navigate evidence. Distinct source contexts remain explicit;
 * a shared spelling alone never asserts that two real-world entities are equal. */
export function graphProjection(shards:GraphShard[]) {
  const nodes=new Map<string,{ name:string;type:string;description:string;properties:any;inputs:GraphInput[] }>();
  const edges=new Map<string,{ sourceName:string;targetName:string;relationType:string;description:string;weight:number;provenance:any[];inputs:GraphInput[] }>();
  for (const shard of [...shards].sort((a,b)=>a.input.documentId.localeCompare(b.input.documentId))) {
    for (const entity of shard.entities) {
      if (!entity.name?.trim()) continue;
      const node=nodes.get(entity.name) || { name:entity.name,type:entity.type,description:'',properties:{ canonicalKind:'surface_form',docIds:[],sourceContexts:[] },inputs:[] };
      if (!node.inputs.some(input=>input.documentId===shard.input.documentId)) node.inputs.push(shard.input);
      if (!node.properties.docIds.includes(shard.input.documentId)) node.properties.docIds.push(shard.input.documentId);
      node.properties.sourceContexts.push({ documentId:shard.input.documentId,versionId:shard.input.versionId,type:entity.type,description:entity.description || '' });
      if (node.type!==entity.type) node.type='concept';
      nodes.set(entity.name,node);
    }
    for (const relation of shard.relations) {
      const key=JSON.stringify([relation.sourceName,relation.targetName,relation.relationType]);
      const edge=edges.get(key) || { sourceName:relation.sourceName,targetName:relation.targetName,relationType:relation.relationType,description:'',weight:0,provenance:[],inputs:[] };
      if (!edge.inputs.some(input=>input.documentId===shard.input.documentId)) edge.inputs.push(shard.input);
      edge.weight=Math.max(edge.weight,Math.max(0,Math.min(10,Number(relation.weight)||1)));
      edge.provenance.push({ documentId:shard.input.documentId,versionId:shard.input.versionId,chunkId:relation.chunkId || null,documentVersion:relation.documentVersion,snippet:relation.snippet || relation.description || '' });
      edges.set(key,edge);
    }
  }
  for (const node of nodes.values()) node.properties.projectionHash=hash([node.name,node.type,node.properties.sourceContexts,node.inputs]);
  for (const [key,edge] of edges) {
    if (!nodes.has(edge.sourceName) || !nodes.has(edge.targetName)) { edges.delete(key);continue; }
    // Endpoint context is also an actual input to interpreting an edge.
    edge.inputs=[...new Map([...edge.inputs,...nodes.get(edge.sourceName)!.inputs,...nodes.get(edge.targetName)!.inputs].map(input=>[input.documentId,input])).values()].sort((a,b)=>a.documentId.localeCompare(b.documentId));
    const fingerprint=hash(edge);
    edge.provenance=edge.provenance.map(item=>({ ...item,projectionHash:fingerprint }));
  }
  return { nodes:[...nodes.values()],edges:[...edges.values()] };
}

export async function reconcileIncrementalGraph(db:PrismaClient,kbId:string,identity:unknown,reusable:boolean,
  extract:(doc:any)=>Promise<{entities:ExtractedEntity[];relations:ExtractedRelation[]}>) {
  if (!getRequestContext()?.servicePrincipal) throw new Error('Graph reconciliation requires an explicit worker identity');
  const docs=await db.document.findMany({ where:{ kbId,status:'published',lifecycleStatus:{ not:'repealed' } },select:{ id:true,title:true,version:true,activeVersionId:true,contentHash:true,chunks:{ orderBy:{ ord:'asc' },take:graphDocumentChunkLimit(),select:{ id:true,content:true,metadata:true } } },orderBy:{ id:'asc' } });
  const previous=await db.$queryRaw<Array<{ documentId:string;fingerprint:string;payload:any }>>`SELECT "documentId",fingerprint,payload FROM "GraphProjectionInput" WHERE "kbId"=${kbId}::uuid`;
  const byId=new Map(previous.map(row=>[row.documentId,row]));
  const prepared:Array<{ documentId:string;fingerprint:string;payload:{ entities:ExtractedEntity[];relations:ExtractedRelation[] };input:GraphInput }>=[];let extracted=0;
  for (const doc of docs) {
    const fingerprint=hash([identity,doc.id,doc.activeVersionId,doc.version,doc.title,doc.contentHash,doc.chunks]);
    const cached=byId.get(doc.id);
    const elements=reusable && cached?.fingerprint===fingerprint ? cached.payload : await extract(doc);
    if (!(reusable && cached?.fingerprint===fingerprint)) extracted++;
    prepared.push({ documentId:doc.id,fingerprint,payload:elements,input:{ documentId:doc.id,versionId:doc.activeVersionId,sourceHash:`${doc.contentHash || ''}:${doc.version}` } });
  }
  const projection=graphProjection(prepared.map(row=>({ input:row.input,...row.payload })));
  let changed=0;
  await withServiceContext(db,async tx=>{
    await tx.$queryRaw`SELECT id FROM "KnowledgeBase" WHERE id=${kbId}::uuid FOR UPDATE`;
    const current=await tx.document.findMany({ where:{ kbId,status:'published',lifecycleStatus:{ not:'repealed' } },select:{ id:true,activeVersionId:true,version:true,contentHash:true },orderBy:{ id:'asc' } });
    if (hash(current.map((doc:any)=>[doc.id,doc.activeVersionId,doc.version,doc.contentHash]))!==hash(docs.map(doc=>[doc.id,doc.activeVersionId,doc.version,doc.contentHash]))) throw new Error('Graph input versions changed; retry reconciliation');
    const existingNodes=await tx.graphEntity.findMany({ where:{ kbId } });
    const existingEdges=await tx.graphRelation.findMany({ where:{ kbId } });
    const nodeByName=new Map<string,any>(existingNodes.map((row:any)=>[row.name,row]));
    const ids=new Map<string,string>();const keepNodes:string[]=[];const keepEdges:string[]=[];
    for (const node of projection.nodes) {
      const old=nodeByName.get(node.name),id=old?.id || randomUUID();ids.set(node.name,id);keepNodes.push(id);
      if ((old?.properties as any)?.projectionHash===node.properties.projectionHash) continue;
      const data={ kbId,name:node.name,type:node.type,description:node.description,properties:node.properties,aliases:[] };
      if (old) await tx.graphEntity.update({ where:{ id },data });else await tx.graphEntity.create({ data:{ id,...data } });
      await replaceProjectionInputs(tx,id,'GraphEntity',node.inputs);
      changed++;
    }
    const edgeByKey=new Map<string,any>(existingEdges.map((row:any)=>[JSON.stringify([row.sourceId,row.targetId,row.relationType]),row]));
    for (const edge of projection.edges) {
      const sourceId=ids.get(edge.sourceName)!,targetId=ids.get(edge.targetName)!;
      const old=edgeByKey.get(JSON.stringify([sourceId,targetId,edge.relationType])),id=old?.id || randomUUID();keepEdges.push(id);
      if ((old?.provenance as any)?.[0]?.projectionHash===edge.provenance[0]?.projectionHash) continue;
      const data={ kbId,sourceId,targetId,relationType:edge.relationType,description:edge.description,weight:edge.weight,provenance:edge.provenance };
      if (old) await tx.graphRelation.update({ where:{ id },data });else await tx.graphRelation.create({ data:{ id,...data } });
      await replaceProjectionInputs(tx,id,'GraphRelation',edge.inputs);
      changed++;
    }
    changed+=(await tx.graphRelation.deleteMany({ where:{ kbId,id:{ notIn:keepEdges } } })).count;
    changed+=(await tx.graphEntity.deleteMany({ where:{ kbId,id:{ notIn:keepNodes } } })).count;
    for (const row of prepared) if (!reusable || byId.get(row.documentId)?.fingerprint!==row.fingerprint) await tx.$executeRaw`INSERT INTO "GraphProjectionInput" ("documentId","kbId",fingerprint,payload) VALUES (${row.documentId}::uuid,${kbId}::uuid,${row.fingerprint},${JSON.stringify(row.payload)}::jsonb) ON CONFLICT("documentId") DO UPDATE SET fingerprint=EXCLUDED.fingerprint,payload=EXCLUDED.payload,"updatedAt"=clock_timestamp()`;
    await tx.$executeRaw`DELETE FROM "GraphProjectionInput" WHERE "kbId"=${kbId}::uuid AND NOT ("documentId"=ANY(${docs.map(doc=>doc.id)}::uuid[]))`;
  });
  return { extracted,changed };
}

export function communityInputFingerprint(cluster:any[],modelIdentity:unknown=process.env.GRAPH_LLM_DEPLOYMENT_REVISION || 'unversioned') {
  return hash(['community-input-v2',modelIdentity,cluster.map(entity=>[entity.id,entity.name,entity.type,entity.description,entity.properties,entity.outgoingRelations]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}
export async function withCommunityInputs<T>(db:PrismaClient,cluster:any[],work:(tx:any)=>Promise<T>):Promise<T> {
  const context=getRequestContext();
  if (!context?.servicePrincipal) throw new Error('Community projection requires worker identity');
  const ids=cluster.flatMap(entity=>[entity.id,...(entity.outgoingRelations || []).map((edge:any)=>edge.id)]);
  return withServiceContext(db, async tx => {
    const inputs:GraphInput[]=await tx.$queryRaw`SELECT DISTINCT "sourceDocumentId"::text AS "documentId","sourceVersionId"::text AS "versionId","sourceHash" FROM "ArtifactDependency" WHERE "artifactId"=ANY(${ids}::text[]) ORDER BY "documentId","versionId","sourceHash"`;
    if (!inputs.length || new Set(inputs.map(input=>input.documentId)).size!==inputs.length) throw new Error('Community has no coherent verified original inputs');
    const documents:any[]=await tx.$queryRaw`SELECT id::text,"activeVersionId"::text AS "versionId",COALESCE("contentHash",'') || ':' || version::text AS "sourceHash",status FROM "Document" WHERE id=ANY(${inputs.map(input=>input.documentId)}::uuid[]) FOR SHARE`;
    const current=new Map(documents.map(document=>[document.id,document]));
    if (inputs.some(input=> {
      const doc=current.get(input.documentId);
      return !doc || doc.status!=='published' || doc.versionId!==input.versionId || doc.sourceHash!==input.sourceHash;
    })) throw new Error('Community input versions changed; retry rebuild');
    const result=await work(tx);
    const artifactId=(result as any)?.id;
    if (!artifactId) throw new Error('Community write returned no artifact identity');
    await replaceProjectionInputs(tx,artifactId,'GraphCommunity',inputs);
    return result;
  });
}
