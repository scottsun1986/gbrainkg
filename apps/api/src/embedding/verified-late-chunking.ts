import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getPrismaClient } from '../prisma';
import { withServiceContext } from '../db/tenant-context.service';
import { instanceIdentity } from '../observability/instance-identity';
import { requestFetch } from '../retrieval/request-signal';
import { assertRequestAuthorization } from '../permission/authorization-revision';
import { uploadRoot } from '../storage/upload-paths';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
type Block = { id: string; charStart: number; charEnd: number };
export type LateCapability = { contract: 'shared-context-pooling-v1'; revision: string; tokenizerRevision: string; model: string; dimensions: number; offsetUnit: 'utf16'; maxChars: number };
export function validateLateCapability(raw: any, revision: string): LateCapability {
  if (!revision || raw?.contract !== 'shared-context-pooling-v1' || raw.revision !== revision || !raw.tokenizerRevision || !raw.model || raw.dimensions !== 1024 || raw.offsetUnit !== 'utf16' || !Number.isInteger(raw.maxChars) || raw.maxChars < 1024 || raw.maxChars > 256000) throw new Error('Unsupported late-chunking capability contract');
  return { contract: raw.contract, revision, tokenizerRevision: raw.tokenizerRevision, model: raw.model, dimensions: raw.dimensions, offsetUnit: raw.offsetUnit, maxChars: raw.maxChars };
}
export function sharedWindows(text: string, blocks: Block[], maxChars: number) {
  const windows: Array<{ start: number; text: string; blocks: Block[] }> = [];
  for (const block of blocks) {
    if (!Number.isInteger(block.charStart) || !Number.isInteger(block.charEnd) || block.charStart < 0 || block.charEnd <= block.charStart || block.charEnd > text.length || block.charEnd-block.charStart > maxChars) throw new Error('Block offset exceeds verified shared-context budget');
    let window = windows[windows.length-1];
    if (!window || block.charEnd > window.start+maxChars) {
      const start = Math.max(0, block.charStart-Math.min(256, maxChars-(block.charEnd-block.charStart)));
      window = { start, text: text.slice(start, start+maxChars), blocks: [] }; windows.push(window);
    }
    window.blocks.push({ ...block, charStart: block.charStart-window.start, charEnd: block.charEnd-window.start });
  }
  return windows;
}
export function validateLateOutput(raw: any, capability: LateCapability, text: string, blocks: Block[]) {
  if (raw?.revision !== capability.revision || raw?.sharedContext !== true || raw?.truncated !== false || raw?.windowHash !== sha(text) || !Array.isArray(raw.blocks) || raw.blocks.length !== blocks.length) throw new Error('Unverified shared-context output');
  const expected = new Map(blocks.map(b => [b.id,b])); const seen = new Set<string>();
  return raw.blocks.map((row: any) => {
    const block = expected.get(row.id);
    if (!block || seen.has(row.id) || row.charStart !== block.charStart || row.charEnd !== block.charEnd || !Array.isArray(row.embedding) || row.embedding.length !== capability.dimensions || row.embedding.some((v: any) => typeof v !== 'number' || !Number.isFinite(v)) || !Array.isArray(row.tokenOffsets) || !row.tokenOffsets.length) throw new Error('Invalid late-chunk vector identity/dimension/offset');
    let previous = -1;
    for (const span of row.tokenOffsets) {
      if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isInteger) || span[0] < 0 || span[1] <= span[0] || span[1] > text.length || span[0] < previous) throw new Error('Invalid tokenizer offset map');
      previous = span[0];
    }
    if (row.tokenOffsets[0][0] > block.charStart || row.tokenOffsets[row.tokenOffsets.length-1][1] < block.charEnd) throw new Error('Pooling does not cover original block');
    seen.add(row.id); return { id: row.id as string, embedding: row.embedding as number[], windowHash: sha(text) };
  });
}

/** Provider must implement shared encoding/pooling. A boolean on independent strings is never accepted. */
export class VerifiedLateChunking {
  private readonly db = getPrismaClient();
  isEnabled() { return process.env.BGE_M3_LATE_CHUNKING_ENABLED === 'true'; }
  private async contract() {
    const endpoint = (process.env.LATE_CHUNKING_ENDPOINT || '').replace(/\/$/,'');
    if (!endpoint) throw new Error('Verified late-chunking provider required');
    const headers = { 'Content-Type':'application/json', ...(process.env.LATE_CHUNKING_API_KEY ? { Authorization: `Bearer ${process.env.LATE_CHUNKING_API_KEY}` } : {}) };
    const response = await requestFetch(`${endpoint}/capabilities`, { headers }, 3000);
    if (!response.ok) throw new Error('Late capability unavailable');
    const capability = validateLateCapability(await response.json(), process.env.LATE_CHUNKING_DEPLOYMENT_REVISION || '');
    const fingerprint = sha(JSON.stringify([instanceIdentity(),endpoint,capability,'raw-shared-window-v1']));
    return { endpoint, headers, capability, fingerprint };
  }
  async buildVersion(versionId: string) {
    if (!this.isEnabled()) return null;
    const contract = await this.contract();
    const version = await this.db.documentVersion.findUniqueOrThrow({ where: { id: versionId }, include: { blocks: { orderBy: { ord:'asc' } }, document: true } });
    if (version.document.activeVersionId !== versionId) throw new Error('Late version superseded');
    const root = uploadRoot(), path=resolve(root,version.mdPath);
    if (!path.startsWith(root+sep) || (await stat(path)).size > 32*1024*1024) throw new Error('Invalid shared-context source');
    const text = await readFile(path,'utf8');
    const vectors: Array<{ id:string; embedding:number[]; windowHash:string }> = [];
    for (const window of sharedWindows(text,version.blocks,contract.capability.maxChars)) {
      const response = await requestFetch(`${contract.endpoint}/late-chunking`, { method:'POST', headers:contract.headers, body:JSON.stringify({ contract:contract.capability.contract, revision:contract.capability.revision, model:contract.capability.model, offsetUnit:'utf16', text:window.text, windowHash:sha(window.text), blocks:window.blocks, instanceId:instanceIdentity() }) }, 60000);
      if (!response.ok) throw new Error('Shared-context encoding failed');
      vectors.push(...validateLateOutput(await response.json(),contract.capability,window.text,window.blocks));
    }
    return withServiceContext(this.db, async tx => {
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${version.documentId}::uuid FOR UPDATE`;
      const doc = await tx.document.findUnique({ where:{ id:version.documentId } });
      if (doc?.activeVersionId !== versionId || doc.status !== 'published') throw new Error('Late version superseded');
      const generation = await tx.indexGeneration.upsert({ where:{ versionId_channel_modelFingerprint_projectionFingerprint:{ versionId, channel:'late_dense', modelFingerprint:contract.fingerprint, projectionFingerprint:'raw-shared-window-v1' } }, create:{ versionId, channel:'late_dense', modelFingerprint:contract.fingerprint, projectionFingerprint:'raw-shared-window-v1', manifestHash:version.manifestHash, expectedCount:version.blocks.length, readyCount:vectors.length, state:'ready' }, update:{} });
      for (const vector of vectors) await tx.$executeRaw`INSERT INTO "LateContextVector" ("generationId","blockId","modelFingerprint","windowHash",embedding) VALUES (${generation.id}::uuid,${vector.id}::uuid,${contract.fingerprint},${vector.windowHash},${JSON.stringify(vector.embedding)}::vector) ON CONFLICT DO NOTHING`;
      const [coverage] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "LateContextVector" WHERE "generationId"=${generation.id}::uuid`;
      if (Number(coverage.count) !== version.blocks.length) throw new Error('Incomplete late-context generation');
      return generation.id;
    });
  }
  async search(kbIds: string[], query: string, limit:number) {
    if (!this.isEnabled()) return [];
    const contract = await this.contract(); await assertRequestAuthorization();
    const response = await requestFetch(`${contract.endpoint}/query`, { method:'POST',headers:contract.headers,body:JSON.stringify({ revision:contract.capability.revision,model:contract.capability.model,text:query,instanceId:instanceIdentity() }) }, 3000);
    if (!response.ok) throw new Error('Late query encoding failed');
    const row:any = await response.json();
    if (row.revision !== contract.capability.revision || !Array.isArray(row.embedding) || row.embedding.length !== 1024 || row.embedding.some((v:any) => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Late query model mismatch');
    return this.db.$queryRaw<any[]>`SELECT c.id,c."documentId",c."kbId",c.ord,c.content,c.metadata,jsonb_build_object('title',d.title,'version',d.version) AS document,1-(v.embedding <=> ${JSON.stringify(row.embedding)}::vector) AS score FROM "LateContextVector" v JOIN "IndexGeneration" g ON g.id=v."generationId" JOIN "Chunk" c ON c.id=v."blockId" JOIN "Document" d ON d.id=c."documentId" WHERE c."kbId"=ANY(${kbIds}::uuid[]) AND d.status='published' AND d."activeVersionId"=g."versionId" AND g.state='ready' AND v."modelFingerprint"=${contract.fingerprint} ORDER BY v.embedding <=> ${JSON.stringify(row.embedding)}::vector LIMIT ${Math.max(1,Math.min(limit,80))}`;
  }
}
